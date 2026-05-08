import type { Pool } from 'pg'
import { getPool } from './db'

// chat_user_id is opaque to RAG — it's whatever the chat side sends in
// the request body (logically chat.users.id from the chat schema).

// Look up the rag.users row without creating one. Use this from any
// endpoint where a stale or accidental call shouldn't materialise a row
// — status, forget, query. /sync is the only legitimate first-touch
// boundary that should auto-create.
export async function findUser(
  tenantId: string,
  chatUserId: string,
  pool: Pool = getPool(),
): Promise<{ id: string } | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM rag.users WHERE tenant_id = $1 AND chat_user_id = $2`,
    [tenantId, chatUserId],
  )
  return rows[0] ?? null
}

// Resolve-or-create the rag.users row. Only call from endpoints where
// the user is *intentionally* signing up for ingest (POST /users/sync).
// Calling this from /status auto-created phantom rows for any 404 hit on
// the chat side and put the worker into a retry loop on never-real users.
export async function resolveUser(
  tenantId: string,
  chatUserId: string,
  pool: Pool = getPool(),
): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO rag.users (tenant_id, chat_user_id)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id, chat_user_id) DO UPDATE SET chat_user_id = EXCLUDED.chat_user_id
     RETURNING id`,
    [tenantId, chatUserId],
  )
  return { id: rows[0]!.id }
}
