import { Hono } from 'hono'
import { getPool } from '../lib/db'
import { requireSession } from '../middleware/session'

export const threadRoutes = new Hono()

threadRoutes.use('*', requireSession)

threadRoutes.get('/', async (c) => {
  const user = c.get('user')
  const pool = getPool()
  const result = await pool.query(
    `SELECT id, title, provider, model, created_at, updated_at
     FROM chat.threads WHERE user_id = $1
     ORDER BY updated_at DESC LIMIT 100`,
    [user.id],
  )
  return c.json({ threads: result.rows })
})

threadRoutes.get('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const pool = getPool()
  // `provider` / `model` are NULL until the first turn locks the thread (or
  // for legacy threads created before I.D.1). The frontend uses these to
  // pre-fill the provider bar when a thread is reopened and to detect a
  // mid-thread switch attempt before sending.
  const thread = await pool.query(
    `SELECT id, title, provider, model FROM chat.threads WHERE id = $1 AND user_id = $2`,
    [id, user.id],
  )
  if (thread.rows.length === 0) return c.json({ error: 'not found' }, 404)

  // DB-21 — keyset pagination. The old query loaded the ENTIRE history in one
  // unbounded scan; a long-lived thread could pull thousands of JSONB rows on
  // every reopen. We now return at most one page (newest-first internally,
  // reversed to ascending for display) so a reopened thread shows current
  // context. `?before=<createdAtISO>,<id>` walks to older pages; we over-fetch
  // by one to report whether more exist. Backed by chat_messages_thread_idx
  // (thread_id, created_at).
  const LIMIT = 200
  const params: unknown[] = [id, user.id]
  let cursorClause = ''
  const before = c.req.query('before')
  if (before) {
    const comma = before.indexOf(',')
    const ts = comma === -1 ? before : before.slice(0, comma)
    const beforeId = comma === -1 ? '' : before.slice(comma + 1)
    if (ts && beforeId) {
      params.push(ts, beforeId)
      cursorClause = `AND (created_at, id) < ($3::timestamptz, $4::text)`
    }
  }
  const result = await pool.query(
    `SELECT id, role, content, created_at
     FROM chat.messages
     WHERE thread_id = $1 AND user_id = $2 ${cursorClause}
     ORDER BY created_at DESC, id DESC
     LIMIT ${LIMIT + 1}`,
    params,
  )
  const hasMore = result.rows.length > LIMIT
  const page = (hasMore ? result.rows.slice(0, LIMIT) : result.rows).reverse()
  const oldest = page[0] as { created_at: Date; id: string } | undefined
  const nextBefore =
    hasMore && oldest ? `${oldest.created_at.toISOString()},${oldest.id}` : null
  return c.json({ thread: thread.rows[0], messages: page, hasMore, nextBefore })
})

threadRoutes.delete('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const pool = getPool()
  await pool.query(
    `DELETE FROM chat.threads WHERE id = $1 AND user_id = $2`,
    [id, user.id],
  )
  return c.json({ ok: true })
})
