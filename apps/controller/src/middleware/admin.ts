import type { MiddlewareHandler } from 'hono'
import { timingSafeEqual } from 'node:crypto'

const ADMIN_TOKEN = process.env.ADMIN_BEARER_TOKEN ?? ''

export const adminConfigured = ADMIN_TOKEN.length > 0

function safeEqString(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Admin-only routes. Single-layer bearer-token gate. ADMIN_BEARER_TOKEN must
 * be set; if it isn't, every admin route returns 503 (disabled). Operators
 * who want defence-in-depth (e.g. only-from-tailnet) should add their own
 * reverse-proxy gate in front of the controller.
 */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  if (!ADMIN_TOKEN) {
    return c.json({ error: 'admin endpoints disabled (set ADMIN_BEARER_TOKEN)' }, 503)
  }
  const auth = c.req.header('authorization')
  const match = auth && /^Bearer\s+(.+)$/i.exec(auth)
  if (!match) return c.json({ error: 'unauthenticated' }, 401)
  if (!safeEqString(match[1]!, ADMIN_TOKEN)) {
    return c.json({ error: 'unauthenticated' }, 401)
  }
  await next()
}
