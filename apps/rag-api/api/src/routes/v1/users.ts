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
userRoutes.get('/:user_id/status', async (c) => {
  const tenant = c.get('tenant')
  const chatUserId = c.req.param('user_id')
  const user = await findUser(tenant.id, chatUserId)
  if (!user) return c.json({ error: 'user not found' }, 404)
  const pool = getPool()

  const [u, jobs, fileCount] = await Promise.all([
    pool.query<{
      last_synced_at: Date | null
      last_error: string | null
      drive_oauth_status: string
      gdrive_my_ai_status: 'unknown' | 'present' | 'missing'
    }>(
      `SELECT last_synced_at, last_error, drive_oauth_status, gdrive_my_ai_status
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
  ])
  const u0 = u.rows[0]
  const inflight = jobs.rows[0]

  return c.json({
    last_synced_at: u0?.last_synced_at?.toISOString() ?? null,
    file_count: Number(fileCount.rows[0]?.count ?? 0),
    in_flight_job_id: inflight?.id ?? null,
    last_error: u0?.last_error ?? null,
    drive_oauth_status: u0?.drive_oauth_status ?? 'pending',
    // Lets the chat-side UX prompt the user to create their personal
    // folder if it's missing, without re-running the Drive lookup.
    my_ai_folder_status: u0?.gdrive_my_ai_status ?? 'unknown',
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
