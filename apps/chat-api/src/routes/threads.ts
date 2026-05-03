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
  const messages = await pool.query(
    `SELECT id, role, content, created_at
     FROM chat.messages WHERE thread_id = $1 AND user_id = $2
     ORDER BY created_at ASC`,
    [id, user.id],
  )
  return c.json({ thread: thread.rows[0], messages: messages.rows })
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
