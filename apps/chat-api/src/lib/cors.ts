// Shared CORS allowlist helper for the Hono apps (chat-api + controller).
//
// Reads ALLOWED_ORIGINS from the environment as a CSV. If unset, falls back
// to a sensible dev default and logs a warning when NODE_ENV === 'production'
// — that combination is a deploy mistake, never an intentional config.
//
// `corsOptions()` returns an object suitable for Hono's `cors()` middleware:
// the `origin` callback returns the request's Origin only when it appears in
// the allowlist (otherwise null, which makes Hono omit the
// Access-Control-Allow-Origin header and effectively reject the cross-origin
// request). `credentials: true` is ALWAYS coupled to a matched origin
// because credentials + a wildcard / reflective origin is the classic CSRF
// footgun this hardening is meant to prevent.

const DEV_DEFAULT = 'http://localhost:5175,http://localhost:3000'

let warned = false

export function getAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS
  if (raw && raw.trim().length > 0) {
    return raw
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0)
  }
  if ((process.env.NODE_ENV ?? 'development') === 'production' && !warned) {
    console.warn(
      '[cors] ALLOWED_ORIGINS is unset in production — falling back to ' +
        `dev defaults (${DEV_DEFAULT}). Set ALLOWED_ORIGINS to a CSV of ` +
        'your real origin(s).',
    )
    warned = true
  }
  return DEV_DEFAULT.split(',')
}

export interface CorsOptions {
  origin: (origin: string) => string | null
  credentials: boolean
  exposeHeaders?: string[]
}

export function corsOptions(opts: { exposeHeaders?: string[] } = {}): CorsOptions {
  const allowed = getAllowedOrigins()
  const set = new Set(allowed)
  return {
    origin: (origin: string) => (origin && set.has(origin) ? origin : null),
    credentials: true,
    ...(opts.exposeHeaders ? { exposeHeaders: opts.exposeHeaders } : {}),
  }
}
