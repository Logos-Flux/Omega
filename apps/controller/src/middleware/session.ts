import type { MiddlewareHandler } from 'hono'
import { getPool } from '../lib/db'

/**
 * Single-user session stub. See apps/chat-api/src/middleware/session.ts for
 * the rationale and pre-OSS pointer. The controller shares the same
 * `chat.users` table as chat-api so the user identity is consistent across
 * services.
 */

export interface SessionUser {
  id: string
  email: string
  name: string | null
  picture: string | null
  sub: string
  releaseChannel: 'alpha' | 'beta' | 'launch'
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
    release_channel: 'alpha' | 'beta' | 'launch'
  }>(
    `INSERT INTO chat.users (email, name, picture, cf_access_sub, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (email) DO UPDATE
       SET last_seen_at = NOW()
     RETURNING id, email, name, picture, cf_access_sub, release_channel`,
    [email, 'Local User', null, `local:${email}`],
  )
  const row = result.rows[0]!
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.picture,
    sub: row.cf_access_sub ?? `local:${email}`,
    releaseChannel: row.release_channel,
  }
}

export const requireSession: MiddlewareHandler = async (c, next) => {
  const user = await upsertUser(DEFAULT_USER_EMAIL)
  c.set('user', user)
  await next()
}
