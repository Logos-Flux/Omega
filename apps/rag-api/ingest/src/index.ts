// rag-ingest worker — drains rag.sync_jobs, runs per-user Drive crawls.
//
// The API queues jobs (`POST /api/v1/users/sync`); we pick them up via
// FOR UPDATE SKIP LOCKED so concurrent ingest containers (when we
// scale beyond one) serialize cleanly. Background re-crawl every
// DEFAULT_POLL_INTERVAL seconds enqueues a sync job for any user whose
// last_synced_at is older than the interval.

import { getPool } from './db'
import { crawlForUser } from './crawler'

// QUAL-12 — process-level crash backstops so a stray rejection surfaces (and
// Fly restarts a clean worker) instead of leaving the loop in limbo.
process.on('unhandledRejection', (reason) => {
  console.error('[rag-ingest] unhandledRejection — exiting', reason)
  process.exit(1)
})
process.on('uncaughtException', (err) => {
  console.error('[rag-ingest] uncaughtException — exiting', err)
  process.exit(1)
})

// BUG-24 — validate numeric env at boot. A garbage value used to flow through
// `Number(...)` as NaN, then `setInterval(..., NaN)` / the staleness math threw
// on every tick and the surrounding catch only warned — silently killing BOTH
// the zombie-reaper and the recrawl enqueue forever. Crash loudly instead.
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `[rag-ingest] invalid ${name}=${JSON.stringify(raw)} — must be a positive number of seconds`,
    )
  }
  return n
}

const DEFAULT_POLL_INTERVAL_S = positiveIntEnv('DEFAULT_POLL_INTERVAL', 900)
const RECRAWL_TICK_MS = 60 * 1000 // check for users due for re-crawl every minute
// A 'running' job older than this is treated as a zombie (see reapStuckJobs).
// Set far above the normal crawl duration (~90s) so an in-flight crawl is
// never falsely reaped — even with multiple ingest containers sharing the
// queue via FOR UPDATE SKIP LOCKED.
const STUCK_JOB_TIMEOUT_S = positiveIntEnv('STUCK_JOB_TIMEOUT_S', 900)

interface JobRow {
  id: string
  user_id: string
}

async function claimNextJob(): Promise<JobRow | null> {
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<JobRow>(
      `SELECT id, user_id FROM rag.sync_jobs
        WHERE status = 'queued'
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
    )
    if (rows.length === 0) {
      await client.query('COMMIT')
      return null
    }
    const job = rows[0]!
    await client.query(
      `UPDATE rag.sync_jobs SET status = 'running', started_at = NOW() WHERE id = $1`,
      [job.id],
    )
    await client.query('COMMIT')
    return job
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function finishJob(
  jobId: string,
  userId: string,
  ok: boolean,
  info: { files_seen?: number; files_changed?: number; files_failed?: number; error?: string; oauthRevoked?: boolean },
): Promise<void> {
  const pool = getPool()
  // BUG-09 — guard on status='running'. A reaper may have already flipped this
  // job to 'failed' (worker looked dead); without the guard a slow-but-alive
  // crawl finishing afterwards would flip it back to 'completed' and erase the
  // reap evidence. RETURNING id lets us skip the rag.users success-write when
  // we lost the race.
  const upd = await pool.query<{ id: string }>(
    `UPDATE rag.sync_jobs
        SET status = $2,
            finished_at = NOW(),
            files_seen = $3,
            files_changed = $4,
            files_failed = $5,
            error = $6
      WHERE id = $1 AND status = 'running'
    RETURNING id`,
    [
      jobId,
      ok ? 'completed' : 'failed',
      info.files_seen ?? null,
      info.files_changed ?? null,
      info.files_failed ?? null,
      info.error ?? null,
    ],
  )
  if (upd.rows.length === 0) {
    // The row was already reaped (or otherwise no longer running) — don't
    // overwrite user state based on a job that lost the race.
    console.warn(`[worker] finishJob: job ${jobId} no longer 'running' (likely reaped) — skipping user update`)
    return
  }
  if (ok) {
    await pool.query(
      `UPDATE rag.users SET last_synced_at = NOW(), last_error = NULL, drive_oauth_status = 'ok' WHERE id = $1`,
      [userId],
    )
  } else {
    // BUG-08 — when the failure is a revoked Google grant, mark the user
    // 'failed' so enqueueRecrawls stops re-queuing them every 15 min forever
    // (the recrawl filter already excludes drive_oauth_status='failed', it was
    // just never set). Transient failures keep 'ok' and retry normally.
    await pool.query(
      `UPDATE rag.users
          SET last_error = $2${info.oauthRevoked ? ", drive_oauth_status = 'failed'" : ''}
        WHERE id = $1`,
      [userId, info.error ?? 'unknown error'],
    )
  }
}

// BUG-08 — retention: terminal sync_jobs accumulate forever otherwise.
// Delete completed/failed jobs older than the retention window each tick.
const JOB_RETENTION_DAYS = 30
export async function pruneOldJobs(): Promise<void> {
  const pool = getPool()
  const { rowCount } = await pool.query(
    `DELETE FROM rag.sync_jobs
      WHERE status IN ('completed', 'failed')
        AND finished_at IS NOT NULL
        AND finished_at < NOW() - ($1 || ' days')::interval`,
    [JOB_RETENTION_DAYS],
  )
  if (rowCount && rowCount > 0) console.log(`[worker] pruned ${rowCount} terminal sync_jobs older than ${JOB_RETENTION_DAYS}d`)
}

async function processOne(): Promise<boolean> {
  const job = await claimNextJob()
  if (!job) return false
  console.log(`[worker] running job ${job.id} for user ${job.user_id}`)
  try {
    const result = await crawlForUser(job.id, job.user_id)
    await finishJob(job.id, job.user_id, true, result)
    console.log(
      `[worker] job ${job.id} done — seen=${result.files_seen} changed=${result.files_changed} failed=${result.files_failed}`,
    )
  } catch (err) {
    const msg = (err as Error).message
    console.warn(`[worker] job ${job.id} failed: ${msg}`)
    // BUG-08 — the controller mint returns 401 (revoked) / 404 (no grant) when
    // the user's Google connection is gone. Either way there's no usable token,
    // so mark the user 'failed' to stop the 15-min recrawl-forever loop until
    // they reconnect (which resets drive_oauth_status).
    const oauthRevoked = /controller mint (401|404)/.test(msg)
    await finishJob(job.id, job.user_id, false, { error: msg, oauthRevoked })
  }
  return true
}

// Reap zombie 'running' jobs. processOne's try/catch only handles a crawl
// that *rejects* — if the worker process itself dies mid-crawl (deploy
// restart, OOM, SIGKILL, or an error that escapes the promise chain), the
// sync_jobs row is left at 'running' with no finished_at. Because
// enqueueRecrawls skips any user with a queued/running job, a single zombie
// silently blocks that user's re-crawls forever (one stranded a user for 3
// weeks — last_synced frozen at 2026-05-15). Mark any 'running' job older
// than STUCK_JOB_TIMEOUT_S as failed so the user is eligible to re-enqueue.
export async function reapStuckJobs(): Promise<void> {
  const pool = getPool()
  const { rows } = await pool.query<{ id: string; user_id: string }>(
    `UPDATE rag.sync_jobs
        SET status = 'failed',
            finished_at = NOW(),
            error = 'reaped: no heartbeat for > ${STUCK_JOB_TIMEOUT_S}s (worker likely died mid-crawl)'
      WHERE status = 'running'
        AND COALESCE(heartbeat_at, started_at) < NOW() - ($1 || ' seconds')::interval
    RETURNING id, user_id`,
    [STUCK_JOB_TIMEOUT_S],
  )
  for (const r of rows) {
    console.warn(
      `[worker] reaped stuck job ${r.id} for user ${r.user_id} (running > ${STUCK_JOB_TIMEOUT_S}s)`,
    )
    await pool.query(`UPDATE rag.users SET last_error = $2 WHERE id = $1`, [
      r.user_id,
      `previous sync did not finish (reaped after ${STUCK_JOB_TIMEOUT_S}s); retrying`,
    ])
  }
}

async function enqueueRecrawls(): Promise<void> {
  const pool = getPool()
  // Enqueue users whose last_synced_at is older than the interval AND
  // who don't already have a queued/running job.
  const cutoffSec = DEFAULT_POLL_INTERVAL_S
  await pool.query(
    `INSERT INTO rag.sync_jobs (user_id, status)
     SELECT u.id, 'queued' FROM rag.users u
      WHERE (u.last_synced_at IS NULL OR u.last_synced_at < NOW() - ($1 || ' seconds')::interval)
        AND u.drive_oauth_status != 'failed'
        AND NOT EXISTS (
          SELECT 1 FROM rag.sync_jobs j
           WHERE j.user_id = u.id AND j.status IN ('queued', 'running')
        )`,
    [cutoffSec],
  )
}

let lastRecrawlEnqueueAt = 0

async function main(): Promise<void> {
  console.log(`[worker] starting; default poll interval ${DEFAULT_POLL_INTERVAL_S}s`)
  while (true) {
    try {
      const did = await processOne()
      if (Date.now() - lastRecrawlEnqueueAt > RECRAWL_TICK_MS) {
        try {
          // Reap before enqueue so a just-reaped user becomes eligible for
          // re-enqueue in the same tick (no extra cycle of latency).
          await reapStuckJobs()
          await enqueueRecrawls()
          await pruneOldJobs()
        } catch (err) {
          console.warn('[worker] recrawl tick failed:', (err as Error).message)
        }
        lastRecrawlEnqueueAt = Date.now()
      }
      if (!did) {
        await new Promise((r) => setTimeout(r, 5000))
      }
    } catch (err) {
      console.error('[worker] tick failed:', err)
      await new Promise((r) => setTimeout(r, 10_000))
    }
  }
}

// Only run the worker loop when executed directly — guarding this lets the
// module's pure helpers be imported by tests without booting the loop.
if (import.meta.main) {
  main().catch((err) => {
    console.error('[worker] crashed', err)
    process.exit(1)
  })
}
