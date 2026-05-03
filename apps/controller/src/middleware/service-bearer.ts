// Service-bearer auth for controller -> consumer trust.
//
// Distinct from `requireSession` (CF Access JWT for end-users) and from
// `requireAdmin` (operator break-glass token). This middleware authenticates
// *services* — currently `rag-api`, soon also `pi-harness`'s gccli shim —
// that need to call the controller on behalf of users (e.g. to mint a Google
// access token from a stored refresh token).
//
// Wire format: `Authorization: Bearer <token>`.
//
// The expected token is read from a configurable env var (default:
// CONTROLLER_SERVICE_TOKEN) at request time, not at module load, so the
// process can pick up rotated secrets via SIGHUP-restart without a code
// change. Comparison is constant-time.
//
// On success the middleware sets a context flag so handlers can distinguish
// service-bearer requests from CF Access user requests if they ever need to.
//
// On failure: 401 with `{ error: 'unauthenticated' }`. We deliberately do
// NOT differentiate "missing header" vs "wrong token" in the response body —
// a probing attacker shouldn't get to learn anything about config state.

import type { MiddlewareHandler } from 'hono'
import { timingSafeEqual } from 'node:crypto'

declare module 'hono' {
  interface ContextVariableMap {
    serviceAuth?: { tokenEnv: string }
  }
}

export interface ServiceBearerOpts {
  /**
   * Name of the env var holding the expected bearer token. Read on every
   * request so rotation works without a process restart at the code level.
   */
  tokenEnv: string
}

function safeEqString(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function serviceBearer(opts: ServiceBearerOpts): MiddlewareHandler {
  return async (c, next) => {
    const expected = process.env[opts.tokenEnv] ?? ''
    if (!expected) {
      // Endpoint is wired but the env var isn't set — treat as disabled.
      // 503 mirrors what `requireAdmin` does when its token is missing.
      return c.json({ error: 'service endpoint disabled' }, 503)
    }
    const auth = c.req.header('authorization')
    const match = auth && /^Bearer\s+(.+)$/i.exec(auth)
    if (!match) return c.json({ error: 'unauthenticated' }, 401)
    if (!safeEqString(match[1]!, expected)) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    c.set('serviceAuth', { tokenEnv: opts.tokenEnv })
    await next()
  }
}
