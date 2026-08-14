import type { MiddlewareHandler } from 'hono'
import { timingSafeEqual } from 'node:crypto'

// SEC-03 — defense-in-depth origin check. When ORIGIN_SHARED_SECRET is set,
// BROWSER requests must carry the matching X-Origin-Shared-Secret header,
// which a Cloudflare Transform Rule injects on every request to your public
// hostname. A direct hit to the origin (e.g. the *.fly.dev address) that
// bypasses Cloudflare is rejected here, behind the CF-Access JWT check.
//
// Unset → disabled, so local dev / docker-compose without the secret keeps
// working (the operator sets it on Fly to activate the layer — see M3).
//
// Carve-out vs intake's browser-only copy: omega backends also take
// service-to-service traffic (controller mint, rag-api) that authenticates
// with `Authorization: Bearer` and may reach the origin directly (off-CF).
// Browser traffic uses cookie auth and never sends an Authorization header,
// so when one IS present we defer to that route's own bearer/JWT middleware
// rather than block a legitimate s2s call. The real auth still fails closed.
const HEADER = 'x-origin-shared-secret'

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export const requireOriginSecret: MiddlewareHandler = async (c, next) => {
  const expected = process.env.ORIGIN_SHARED_SECRET
  if (!expected) return next()
  if (c.req.header('authorization')) return next()
  const got = c.req.header(HEADER)
  if (!got || !safeEq(got, expected)) return c.json({ error: 'forbidden' }, 403)
  return next()
}
