import type { MiddlewareHandler } from 'hono'
import { getPool } from '../lib/db'
import { extractToken, readCfAccessConfig, verifyCfAccessJwt, type CfAccessConfig } from './cf-access'

/**
 * Session middleware. Two modes:
 *
 * 1. **Cloudflare Access** — when `CF_ACCESS_TEAM_DOMAIN` and
 *    `CF_ACCESS_AUD` are set, every request must carry a valid CF Access
 *    JWT. The verified `email` and `sub` claims identify the user; we
 *    upsert `chat.users` keyed on `cf_access_sub` so a user keeps the
 *    same row even if their email changes. This is the only safe mode
 *    for multi-tenant deploys.
 *
 * 2. **Single-user stub** — when no CF Access env is configured, every
 *    request maps to `DEFAULT_USER_EMAIL` (default `local@localhost`).
 *    This preserves the historical OSS dev/self-host UX where the
 *    operator provides their own perimeter auth (oauth2-proxy, Caddy
 *    basic auth, Tailscale serve, etc.) and the API trusts whoever can
 *    reach it.
 *
 * The dispatch happens at module load. If only one of the two CF Access
 * env vars is set, that's a misconfiguration and `readCfAccessConfig`
 * throws — we let the process fail to start rather than fall back to
 * the stub silently.
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

interface UserRow {
  id: string
  email: string
  name: string | null
  picture: string | null
  cf_access_sub: string | null
}

function rowToUser(row: UserRow, fallbackSub: string): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.picture,
    sub: row.cf_access_sub ?? fallbackSub,
  }
}

async function upsertStubUser(email: string): Promise<SessionUser> {
  const pool = getPool()
  const result = await pool.query<UserRow>(
    `INSERT INTO chat.users (email, name, picture, cf_access_sub, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (email) DO UPDATE
       SET last_seen_at = NOW()
     RETURNING id, email, name, picture, cf_access_sub`,
    [email, 'Local User', null, `local:${email}`],
  )
  return rowToUser(result.rows[0]!, `local:${email}`)
}

async function upsertCfAccessUser(sub: string, email: string): Promise<SessionUser> {
  const pool = getPool()
  // ON CONFLICT on cf_access_sub is the primary path; email may legitimately
  // change between sessions (CF Access reads email from the IdP each time).
  const result = await pool.query<UserRow>(
    `INSERT INTO chat.users (email, name, picture, cf_access_sub, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (cf_access_sub) DO UPDATE
       SET email = EXCLUDED.email,
           last_seen_at = NOW()
     RETURNING id, email, name, picture, cf_access_sub`,
    [email, null, null, sub],
  )
  return rowToUser(result.rows[0]!, sub)
}

let cachedConfig: CfAccessConfig | null | undefined

function getConfig(): CfAccessConfig | null {
  if (cachedConfig === undefined) cachedConfig = readCfAccessConfig()
  return cachedConfig
}

// Test-only: reset the cached config so tests can flip env between cases.
export function _resetSessionConfigForTests(): void {
  cachedConfig = undefined
}

export const requireSession: MiddlewareHandler = async (c, next) => {
  const config = getConfig()
  if (!config) {
    const user = await upsertStubUser(DEFAULT_USER_EMAIL)
    c.set('user', user)
    await next()
    return
  }
  const token = extractToken(c.req.header('Cf-Access-Jwt-Assertion'), readCookie(c.req.header('cookie'), 'CF_Authorization'))
  if (!token) return c.json({ error: 'unauthenticated' }, 401)
  let claims
  try {
    claims = await verifyCfAccessJwt(token, config)
  } catch {
    return c.json({ error: 'unauthenticated' }, 401)
  }
  const user = await upsertCfAccessUser(claims.sub, claims.email)
  c.set('user', user)
  await next()
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}
