import type { MiddlewareHandler } from 'hono'
import { createHash, timingSafeEqual } from 'node:crypto'
import { getPool } from '../lib/db'

export interface Tenant {
  id: string
  slug: string
  name: string
}

declare module 'hono' {
  interface ContextVariableMap {
    tenant: Tenant
  }
}

const DEV_BEARER_TOKEN = process.env.DEV_BEARER_TOKEN ?? ''

// Bearer token resolution. The Caddy edge already enforces that *some*
// valid token is present; this layer is the source of truth for which
// tenant a request belongs to. Tokens are stored sha256-hashed in
// rag.api_keys.
export const requireTenant: MiddlewareHandler = async (c, next) => {
  const auth = c.req.header('authorization') ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (!m) return c.json({ error: 'missing bearer token' }, 401)
  const token = m[1]!

  if (DEV_BEARER_TOKEN && tokensEqual(token, DEV_BEARER_TOKEN)) {
    const tenant = await loadTenantBySlug('omega')
    if (!tenant) return c.json({ error: 'dev tenant not found' }, 500)
    c.set('tenant', tenant)
    return next()
  }

  const tenant = await loadTenantByToken(token)
  if (!tenant) return c.json({ error: 'invalid token' }, 401)

  c.set('tenant', tenant)
  return next()
}

function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function loadTenantBySlug(slug: string): Promise<Tenant | null> {
  const { rows } = await getPool().query<Tenant>(
    'SELECT id, slug, name FROM rag.tenants WHERE slug = $1',
    [slug],
  )
  return rows[0] ?? null
}

async function loadTenantByToken(token: string): Promise<Tenant | null> {
  const hash = sha256Hex(token)
  const { rows } = await getPool().query<Tenant>(
    `SELECT t.id, t.slug, t.name
       FROM rag.api_keys k
       JOIN rag.tenants t ON t.id = k.tenant_id
      WHERE k.token_sha256 = $1
        AND k.revoked_at IS NULL`,
    [hash],
  )
  if (rows.length === 0) return null
  // Best-effort last_used_at update; don't fail the request if it errors.
  getPool()
    .query('UPDATE rag.api_keys SET last_used_at = NOW() WHERE token_sha256 = $1', [hash])
    .catch(() => {})
  return rows[0] ?? null
}
