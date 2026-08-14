import { Hono } from 'hono'
import { getPool } from '../../lib/db'
import { findUser, resolveUser } from '../../lib/users'
import { resolveTenantDataset } from '../../lib/dataset'
import { deleteDocument } from '../../lib/ragflow'

export const userRoutes = new Hono()

interface SyncBody {
  user_id?: string
  force?: boolean
}

// POST /api/v1/users/sync — kick off (or join) a Drive crawl for user.
userRoutes.post('/sync', async (c) => {
  const tenant = c.get('tenant')
  const body = (await c.req.json().catch(() => ({}))) as SyncBody
  if (!body.user_id) return c.json({ error: 'user_id required' }, 400)

  const user = await resolveUser(tenant.id, body.user_id)
  const pool = getPool()

  // If a job is already queued or running for this user, return that
  // one (idempotency). force=true bypasses and creates a new job — we
  // accept the risk of two concurrent crawls (the worker uses
  // FOR UPDATE SKIP LOCKED so they serialize).
  if (!body.force) {
    const inflight = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM rag.sync_jobs
        WHERE user_id = $1 AND status IN ('queued', 'running')
        ORDER BY created_at DESC
        LIMIT 1`,
      [user.id],
    )
    if (inflight.rows.length > 0) {
      const j = inflight.rows[0]!
      return c.json({ job_id: j.id, status: j.status })
    }
  }

  const created = await pool.query<{ id: string; status: string }>(
    `INSERT INTO rag.sync_jobs (user_id, status) VALUES ($1, 'queued') RETURNING id, status`,
    [user.id],
  )
  return c.json({ job_id: created.rows[0]!.id, status: created.rows[0]!.status })
})

// GET /api/v1/users/:user_id/status
//
// 404 for unknown users — never auto-creates a row. The chat side's
// "Indexing your Drive…" UI polls this; without the 404 a typo'd or
// stale user_id would silently provision a phantom row and feed the
// worker a retry loop on a user who never asked to ingest.
//
// In filesystem mode (RAG_SOURCE=filesystem) the response also carries
// `filesystem_*` fields scoped to the filesystem source so the
// chat-frontend's <FilesystemPane> can render the right state. In drive
// mode the response shape is unchanged from v0.5.x — the new fields
// are omitted (not set to null) so the drive-mode payload is bit-identical.
userRoutes.get('/:user_id/status', async (c) => {
  const tenant = c.get('tenant')
  const chatUserId = c.req.param('user_id')
  const user = await findUser(tenant.id, chatUserId)
  if (!user) return c.json({ error: 'user not found' }, 404)
  const pool = getPool()
  const sourceMode = (process.env.RAG_SOURCE ?? 'drive').trim().toLowerCase()
  const includeFilesystem = sourceMode === 'filesystem'

  const [u, jobs, fileCount, filesystemStats] = await Promise.all([
    pool.query<{
      last_synced_at: Date | null
      last_error: string | null
      drive_oauth_status: string
      gdrive_my_ai_status: 'unknown' | 'present' | 'missing'
      filesystem_status: 'unknown' | 'present' | 'missing'
    }>(
      `SELECT last_synced_at, last_error, drive_oauth_status, gdrive_my_ai_status, filesystem_status
         FROM rag.users WHERE id = $1`,
      [user.id],
    ),
    pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM rag.sync_jobs
        WHERE user_id = $1 AND status IN ('queued', 'running')
        ORDER BY created_at DESC
        LIMIT 1`,
      [user.id],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM rag.user_file_access WHERE user_id = $1`,
      [user.id],
    ),
    // Only run when filesystem fields are needed so a drive-mode
    // deploy doesn't pay the cost on every poll. Counts files visible
    // to this user via filesystem rows; last_walk_ts uses the most
    // recent finished filesystem-source crawl.
    includeFilesystem
      ? pool.query<{ file_count: string; last_walk_ts: Date | null }>(
          `SELECT
             COUNT(*) FILTER (WHERE f.source_kind = 'filesystem')::text AS file_count,
             MAX(f.last_indexed_at) FILTER (WHERE f.source_kind = 'filesystem') AS last_walk_ts
           FROM rag.user_file_access a
           JOIN rag.files f ON f.id = a.file_id
           WHERE a.user_id = $1`,
          [user.id],
        )
      : Promise.resolve({ rows: [] as Array<{ file_count: string; last_walk_ts: Date | null }> }),
  ])
  const u0 = u.rows[0]
  const inflight = jobs.rows[0]

  const base = {
    last_synced_at: u0?.last_synced_at?.toISOString() ?? null,
    file_count: Number(fileCount.rows[0]?.count ?? 0),
    in_flight_job_id: inflight?.id ?? null,
    last_error: u0?.last_error ?? null,
    drive_oauth_status: u0?.drive_oauth_status ?? 'pending',
    // Lets the chat-side UX prompt the user to create their personal
    // folder if it's missing, without re-running the Drive lookup.
    my_ai_folder_status: u0?.gdrive_my_ai_status ?? 'unknown',
  }

  if (!includeFilesystem) return c.json(base)

  const fs = filesystemStats.rows[0]
  return c.json({
    ...base,
    filesystem_status: u0?.filesystem_status ?? 'unknown',
    filesystem_file_count: Number(fs?.file_count ?? 0),
    filesystem_last_walk_ts: fs?.last_walk_ts?.toISOString() ?? null,
  })
})

// POST /api/v1/users/:user_id/forget
// Drops user_file_access rows; garbage-collects rag.files rows that
// now have zero referrers (and tells RAGFlow to delete the doc too).
//
// Idempotent: unknown user_ids return `removed_files: 0` rather than
// 404, so a "forget me" that runs twice (or hits a user the chat side
// already cleaned up) doesn't error.
userRoutes.post('/:user_id/forget', async (c) => {
  const tenant = c.get('tenant')
  const chatUserId = c.req.param('user_id')
  const user = await findUser(tenant.id, chatUserId)
  if (!user) return c.json({ ok: true, removed_files: 0 })
  const pool = getPool()
  const dataset = await resolveTenantDataset(tenant.id)

  const orphans = await pool.query<{ id: string; ragflow_doc_id: string | null }>(
    `WITH dropped AS (
       DELETE FROM rag.user_file_access WHERE user_id = $1 RETURNING file_id
     )
     SELECT f.id, f.ragflow_doc_id
       FROM rag.files f
      WHERE f.id IN (SELECT file_id FROM dropped)
        AND NOT EXISTS (
          SELECT 1 FROM rag.user_file_access a WHERE a.file_id = f.id
        )`,
    [user.id],
  )

  if (orphans.rows.length > 0 && dataset) {
    for (const row of orphans.rows) {
      if (!row.ragflow_doc_id) continue
      try {
        await deleteDocument(dataset.ragflow_dataset_id, row.ragflow_doc_id)
      } catch (err) {
        console.warn('[forget] ragflow delete failed for', row.ragflow_doc_id, (err as Error).message)
      }
    }
    await pool.query(`DELETE FROM rag.files WHERE id = ANY($1::uuid[])`, [orphans.rows.map((r) => r.id)])
  }

  return c.json({ ok: true, removed_files: orphans.rows.length })
})
