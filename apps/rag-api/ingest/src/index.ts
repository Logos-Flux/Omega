// rag-ingest worker — drains rag.sync_jobs, runs per-user Drive crawls.
//
// The API queues jobs (`POST /api/v1/users/sync`); we pick them up via
// FOR UPDATE SKIP LOCKED so concurrent ingest containers (when we
// scale beyond one) serialize cleanly. Background re-crawl every
// DEFAULT_POLL_INTERVAL seconds enqueues a sync job for any user whose
// last_synced_at is older than the interval.

import { getPool } from './db'
import { crawlForUser } from './crawler'

const DEFAULT_POLL_INTERVAL_S = Number(process.env.DEFAULT_POLL_INTERVAL ?? 900)
const RECRAWL_TICK_MS = 60 * 1000 // check for users due for re-crawl every minute

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

async function finishJob(jobId: string, userId: string, ok: boolean, info: { files_seen?: number; files_changed?: number; error?: string }): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE rag.sync_jobs
        SET status = $2,
            finished_at = NOW(),
            files_seen = $3,
            files_changed = $4,
            error = $5
      WHERE id = $1`,
    [jobId, ok ? 'completed' : 'failed', info.files_seen ?? null, info.files_changed ?? null, info.error ?? null],
  )
  if (ok) {
    await pool.query(
      `UPDATE rag.users SET last_synced_at = NOW(), last_error = NULL, drive_oauth_status = 'ok' WHERE id = $1`,
      [userId],
    )
  } else {
    await pool.query(
      `UPDATE rag.users SET last_error = $2 WHERE id = $1`,
      [userId, info.error ?? 'unknown error'],
    )
  }
}

async function processOne(): Promise<boolean> {
  const job = await claimNextJob()
  if (!job) return false
  console.log(`[worker] running job ${job.id} for user ${job.user_id}`)
  try {
    const result = await crawlForUser(job.id, job.user_id)
    await finishJob(job.id, job.user_id, true, result)
    console.log(`[worker] job ${job.id} done — seen=${result.files_seen} changed=${result.files_changed}`)
  } catch (err) {
    const msg = (err as Error).message
    console.warn(`[worker] job ${job.id} failed: ${msg}`)
    await finishJob(job.id, job.user_id, false, { error: msg })
  }
  return true
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
          await enqueueRecrawls()
        } catch (err) {
          console.warn('[worker] enqueueRecrawls failed:', (err as Error).message)
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

main().catch((err) => {
  console.error('[worker] crashed', err)
  process.exit(1)
})
