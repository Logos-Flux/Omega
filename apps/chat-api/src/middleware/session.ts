import type { MiddlewareHandler } from 'hono'
import { getPool } from '../lib/db'

/**
 * Single-user session stub. The OSS build doesn't ship app-level auth —
 * operators add their own (oauth2-proxy, Caddy basic auth, Tailscale serve,
 * etc.) — so the API trusts whoever can reach it.
 *
 * To preserve the per-user data shape the routes expect, we upsert a
 * `chat.users` row keyed on `DEFAULT_USER_EMAIL` (default `local@localhost`)
 * and attach it as `c.var.user`. Multi-user deployments can replace this
 * file with a JWT-verifying middleware (see git history pre-OSS for the CF
 * Access verifier we used in production).
 */

export interface SessionUser {
  id: string // internal UUID (chat.users.id)
  email: string
  name: string | null
  picture: string | null
  sub: string
}

declare module 'hono' {
  interface ContextVariableMap {
    user: SessionUser
  }
}

const DEFAULT_USER_EMAIL = process.env.DEFAULT_USER_EMAIL ?? 'local@localhost'

async function upsertUser(email: string): Promise<SessionUser> {
  const pool = getPool()
  const result = await pool.query<{
    id: string
    email: string
    name: string | null
    picture: string | null
    cf_access_sub: string | null
  }>(
    `INSERT INTO chat.users (email, name, picture, cf_access_sub, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (email) DO UPDATE
       SET last_seen_at = NOW()
     RETURNING id, email, name, picture, cf_access_sub`,
    [email, 'Local User', null, `local:${email}`],
  )
  const row = result.rows[0]!
  return { id: row.id, email: row.email, name: row.name, picture: row.picture, sub: row.cf_access_sub ?? `local:${email}` }
}

export const requireSession: MiddlewareHandler = async (c, next) => {
  const user = await upsertUser(DEFAULT_USER_EMAIL)
  c.set('user', user)
  await next()
}
