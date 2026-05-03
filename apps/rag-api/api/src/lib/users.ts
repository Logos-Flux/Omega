import { getPool } from './db'

// Resolve-or-create the rag.users row for (tenant_id, chat_user_id).
// chat_user_id is opaque to RAG — it's whatever the chat side sends in
// the request body (logically chat.users.id from Fly Postgres).
export async function resolveUser(tenantId: string, chatUserId: string): Promise<{ id: string }> {
  const pool = getPool()
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO rag.users (tenant_id, chat_user_id)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id, chat_user_id) DO UPDATE SET chat_user_id = EXCLUDED.chat_user_id
     RETURNING id`,
    [tenantId, chatUserId],
  )
  return { id: rows[0]!.id }
}
