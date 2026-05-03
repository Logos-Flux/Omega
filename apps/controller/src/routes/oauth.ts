// Phase 0.B.2 + 0.B.3 — Google OAuth flow endpoints.
//
// Four handlers, all under /api/oauth/google/*:
//
//   GET  /start         — JWT-gated. 302 to Google consent screen.
//   GET  /callback      — NOT JWT-gated. Google redirects here with ?code=&state=.
//                         Identity comes from the HMAC-signed `state` param.
//   GET  /status        — JWT-gated. Returns whether the user has tokens stored.
//   POST /access-token  — service-bearer-gated. Mints a short-lived access
//                         token from the stored refresh token. Consumed by
//                         rag-api today, pi-harness's gccli shim later.
//
// State signing reuses HARNESS_JWT_SECRET (HS256-style HMAC over a JSON
// payload). Reasoning: state is short-lived (5 min) and the secret is
// already deployed; introducing a second OAUTH_STATE_SECRET would be one
// more thing to set without buying meaningful key separation. Documented
// in CLAUDE.md / .env.example. Switch to a dedicated secret if state-sig
// reuse ever becomes a concern.

import { Hono } from 'hono'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { getPool, hasDatabase } from '../lib/db'
import { encryptToken, decryptToken } from '../lib/crypto'
import { requireSession } from '../middleware/session'
import { serviceBearer } from '../middleware/service-bearer'

// ---------- Constants ----------

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'openid',
  'email',
]

const STATE_TTL_SEC = 5 * 60

// Read the public-host allowlist from env at call time so tests / operators
// can change it without re-importing this module. See .env.example for the
// expected format. Empty list when the env var is unset — this means a fresh
// deploy with ENABLE_GOOGLE_OAUTH=true but no ALLOWED_RETURN_HOSTS will only
// accept localhost return_to in dev mode and reject every public host. We
// log a one-shot warning at module load if oauth is enabled but the var is
// missing, so the misconfig is loud.
function getAllowedReturnHosts(): string[] {
  const raw = process.env.ALLOWED_RETURN_HOSTS
  if (!raw || raw.trim().length === 0) return []
  return raw
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0)
}

if (
  (process.env.ENABLE_GOOGLE_OAUTH ?? 'false').toLowerCase() === 'true' &&
  getAllowedReturnHosts().length === 0
) {
  console.warn(
    '[oauth] ENABLE_GOOGLE_OAUTH=true but ALLOWED_RETURN_HOSTS is empty — ' +
      'public-host return_to URLs will all be rejected. Set ALLOWED_RETURN_HOSTS ' +
      'to a CSV of hostnames (e.g. `chat.example.com,example.com`).',
  )
}

// ---------- return_to allowlist ----------

export interface ValidateReturnToOpts {
  /** When true, localhost / 127.0.0.1 over http is also accepted. */
  allowLocalhost: boolean
}

/**
 * Returns a normalized return-to URL when valid, or null when rejected.
 * Production allows only the hostnames listed in ALLOWED_RETURN_HOSTS over
 * https. Dev additionally allows http://localhost and http://127.0.0.1
 * on any port.
 *
 * Defense-in-depth: rejects URLs with embedded credentials or any non-empty
 * fragment. A non-empty `#hash` is suspicious because once we 302 to the URL,
 * the fragment lands in the browser's address bar without ever hitting a
 * server, so it's a popular vehicle for redirect-into-fragment-XSS gadgets.
 */
export function validateReturnTo(raw: unknown, opts: ValidateReturnToOpts): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  // No embedded credentials, no fragment.
  if (url.username || url.password) return null
  if (url.hash && url.hash.length > 0) return null

  const host = url.hostname
  const allowedHosts = getAllowedReturnHosts()
  if (url.protocol === 'https:' && allowedHosts.includes(host)) {
    return url.toString()
  }
  if (
    opts.allowLocalhost &&
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (host === 'localhost' || host === '127.0.0.1')
  ) {
    return url.toString()
  }
  return null
}

// ---------- State HMAC ----------

interface StatePayload {
  userId: string
  returnTo: string
  nonce: string
  exp: number // unix seconds
}

function getStateSecret(): string {
  const s = process.env.HARNESS_JWT_SECRET
  if (!s) throw new Error('HARNESS_JWT_SECRET not set (required for OAuth state signing)')
  return s
}

function b64urlEncodeStr(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url')
}

function hmac(input: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(input).digest()
}

export function signState(args: {
  userId: string
  returnTo: string
  ttlSec?: number
  nonce?: string
}): string {
  const ttl = args.ttlSec ?? STATE_TTL_SEC
  const payload: StatePayload = {
    userId: args.userId,
    returnTo: args.returnTo,
    nonce: args.nonce ?? randomBytes(12).toString('base64url'),
    exp: Math.floor(Date.now() / 1000) + ttl,
  }
  const body = b64urlEncodeStr(JSON.stringify(payload))
  const sig = hmac(body, getStateSecret()).toString('base64url')
  return `${body}.${sig}`
}

export function verifyState(state: string): StatePayload {
  const parts = state.split('.')
  if (parts.length !== 2) throw new Error('malformed state')
  const [bodyB64, sigB64] = parts as [string, string]
  const expected = hmac(bodyB64, getStateSecret())
  const provided = Buffer.from(sigB64, 'base64url')
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new Error('state signature invalid')
  }
  const payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8')) as StatePayload
  if (
    typeof payload.userId !== 'string' ||
    typeof payload.returnTo !== 'string' ||
    typeof payload.nonce !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    throw new Error('state missing required fields')
  }
  if (payload.exp * 1000 < Date.now()) throw new Error('state expired')
  return payload
}

// ---------- Google OAuth client config ----------

function googleClientConfig(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not set')
  }
  // Allow override for local dev; default to the prod controller host.
  const redirectUri =
    process.env.GOOGLE_OAUTH_REDIRECT_URI ??
    'https://<your-controller>.fly.dev/api/oauth/google/callback'
  return { clientId, clientSecret, redirectUri }
}

export function buildGoogleAuthUrl(args: { state: string; clientId: string; redirectUri: string }): string {
  const u = new URL(GOOGLE_AUTH_URL)
  u.searchParams.set('client_id', args.clientId)
  u.searchParams.set('redirect_uri', args.redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', SCOPES.join(' '))
  u.searchParams.set('access_type', 'offline')
  u.searchParams.set('prompt', 'consent')
  u.searchParams.set('include_granted_scopes', 'true')
  u.searchParams.set('state', args.state)
  return u.toString()
}

// ---------- DB helpers ----------

export interface OAuthTokenRow {
  user_id: string
  provider: string
  scopes: string[]
  granted_at: string
  last_refreshed_at: string | null
}

async function readTokenRow(userId: string, provider: string): Promise<OAuthTokenRow | null> {
  if (!hasDatabase) return null
  const res = await getPool().query<OAuthTokenRow>(
    `SELECT user_id, provider, scopes, granted_at, last_refreshed_at
     FROM pi.oauth_tokens WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  )
  return res.rows[0] ?? null
}

async function upsertTokenRow(args: {
  userId: string
  provider: string
  refreshTokenCt: string
  scopes: string[]
}): Promise<void> {
  if (!hasDatabase) return
  // On insert: granted_at defaults to NOW() (schema default), last_refreshed_at NULL.
  // On update: keep the original granted_at (don't touch it), bump last_refreshed_at to NOW(),
  // overwrite refresh_token + scopes with the freshly-issued values.
  await getPool().query(
    `INSERT INTO pi.oauth_tokens (user_id, provider, refresh_token, scopes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, provider) DO UPDATE
       SET refresh_token = EXCLUDED.refresh_token,
           scopes = EXCLUDED.scopes,
           last_refreshed_at = NOW()`,
    [args.userId, args.provider, args.refreshTokenCt, args.scopes],
  )
}

// ---------- Routes ----------

export const oauthRoutes = new Hono()

// /start — JWT-gated. Build consent URL and 302 to Google.
oauthRoutes.get('/google/start', requireSession, (c) => {
  const user = c.get('user')
  const allowLocalhost = (process.env.NODE_ENV ?? 'development') !== 'production'
  const returnTo = validateReturnTo(c.req.query('return_to'), { allowLocalhost })
  if (!returnTo) {
    return c.json(
      {
        error:
          'invalid return_to: must be http://localhost:5175, http://localhost, or (in dev) localhost/127.0.0.1',
      },
      400,
    )
  }

  let cfg
  try {
    cfg = googleClientConfig()
  } catch (err) {
    console.error('[oauth] google client misconfigured:', (err as Error).message)
    return c.json({ error: 'oauth not configured on this server' }, 500)
  }

  const state = signState({ userId: user.id, returnTo })
  const url = buildGoogleAuthUrl({ state, clientId: cfg.clientId, redirectUri: cfg.redirectUri })
  return c.redirect(url, 302)
})

// /callback — NOT JWT-gated. Google calls this; identity comes from state.
oauthRoutes.get('/google/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const errParam = c.req.query('error')
  if (errParam) {
    return c.json({ error: `google denied: ${errParam}` }, 400)
  }
  if (!code || !state) {
    return c.json({ error: 'missing code or state' }, 400)
  }

  let payload: StatePayload
  try {
    payload = verifyState(state)
  } catch (err) {
    console.warn('[oauth] state verify failed:', (err as Error).message)
    return c.json({ error: 'invalid state' }, 400)
  }

  let cfg
  try {
    cfg = googleClientConfig()
  } catch (err) {
    console.error('[oauth] google client misconfigured:', (err as Error).message)
    return c.json({ error: 'oauth not configured on this server' }, 500)
  }

  // Exchange code for tokens.
  let tokenRes: Response
  try {
    tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: cfg.redirectUri,
        grant_type: 'authorization_code',
      }),
    })
  } catch (err) {
    console.error('[oauth] google token fetch threw:', err)
    return c.json({ error: 'google token exchange failed' }, 502)
  }

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '')
    console.error(`[oauth] google token exchange ${tokenRes.status}: ${body}`)
    return c.json({ error: `google token exchange failed: ${tokenRes.status}` }, 502)
  }

  const tokenBody = (await tokenRes.json().catch(() => null)) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
    token_type?: string
  } | null

  if (!tokenBody) {
    return c.json({ error: 'google token response was not JSON' }, 502)
  }

  if (!tokenBody.refresh_token) {
    // We forced prompt=consent, so this should be impossible. If it happens
    // it's almost always because the user previously consented and Google
    // is suppressing the new refresh token despite our prompt — known
    // footgun. Surface a clear error rather than upserting an empty row.
    console.error(
      `[oauth] google response had no refresh_token for user ${payload.userId}; ` +
        `scopes=${tokenBody.scope ?? '<none>'}`,
    )
    return c.json(
      {
        error:
          'google did not return a refresh_token. ' +
          'Visit https://myaccount.google.com/permissions, remove access for the Omega app, and try again.',
      },
      500,
    )
  }

  const scopes = (tokenBody.scope ?? '').split(/\s+/).filter((s) => s.length > 0)

  let ciphertext: string
  try {
    ciphertext = encryptToken(tokenBody.refresh_token)
  } catch (err) {
    console.error('[oauth] encryptToken failed:', err)
    return c.json({ error: 'token encryption failed' }, 500)
  }

  try {
    await upsertTokenRow({
      userId: payload.userId,
      provider: 'google',
      refreshTokenCt: ciphertext,
      scopes,
    })
  } catch (err) {
    console.error('[oauth] upsert pi.oauth_tokens failed:', err)
    return c.json({ error: 'failed to persist tokens' }, 500)
  }

  return c.redirect(payload.returnTo, 302)
})

// /status — JWT-gated. Returns connection state for each provider.
oauthRoutes.get('/google/status', requireSession, async (c) => {
  const user = c.get('user')
  const row = await readTokenRow(user.id, 'google').catch((err) => {
    console.error('[oauth] /status read failed:', err)
    return null
  })
  if (!row) {
    return c.json({ google: { connected: false, scopes: [], granted_at: null } })
  }
  return c.json({
    google: {
      connected: true,
      scopes: row.scopes,
      granted_at: row.granted_at,
    },
  })
})

// ---------- Phase 0.B.3 — token-mint endpoint ----------

// UUID v1-v5 syntactic check. Body validation only — a wrong-but-syntactically
// valid id just falls through to the 404 path below.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface RefreshExchangeOk {
  access_token: string
  expires_in: number
  scope?: string
  token_type?: string
}

/** Read just the encrypted refresh_token (separate from readTokenRow which
 *  intentionally does NOT select it — keeping the leak surface narrow). */
async function readRefreshTokenCt(
  userId: string,
  provider: string,
): Promise<string | null> {
  if (!hasDatabase) return null
  const res = await getPool().query<{ refresh_token: string }>(
    `SELECT refresh_token FROM pi.oauth_tokens WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  )
  return res.rows[0]?.refresh_token ?? null
}

/** Look up the user's Google email from `chat.users` (CF Access uses Google
 *  sign-in, so this column IS the user's Google email). Returns null if the
 *  user row is missing — pathological state when an `pi.oauth_tokens` row
 *  exists, but we'd rather log + omit than 500 the mint. */
async function readUserEmail(userId: string): Promise<string | null> {
  if (!hasDatabase) return null
  const res = await getPool().query<{ email: string }>(
    `SELECT email FROM chat.users WHERE id = $1`,
    [userId],
  )
  return res.rows[0]?.email ?? null
}

async function deleteTokenRow(userId: string, provider: string): Promise<void> {
  if (!hasDatabase) return
  await getPool().query(
    `DELETE FROM pi.oauth_tokens WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  )
}

async function bumpRefreshedAt(args: {
  userId: string
  provider: string
  scopes: string[] | null
}): Promise<void> {
  if (!hasDatabase) return
  if (args.scopes && args.scopes.length > 0) {
    await getPool().query(
      `UPDATE pi.oauth_tokens
         SET last_refreshed_at = NOW(),
             scopes = $3
       WHERE user_id = $1 AND provider = $2`,
      [args.userId, args.provider, args.scopes],
    )
  } else {
    await getPool().query(
      `UPDATE pi.oauth_tokens
         SET last_refreshed_at = NOW()
       WHERE user_id = $1 AND provider = $2`,
      [args.userId, args.provider],
    )
  }
}

/**
 * Exchange a refresh_token at Google's token endpoint. Exported for testing.
 * Returns:
 *   { kind: 'ok', body }       — Google returned 2xx with parsed JSON.
 *   { kind: 'revoked' }        — Google returned 400/401 (refresh token bad).
 *   { kind: 'transient', ... } — anything else (5xx / network / non-JSON).
 */
export async function exchangeRefreshToken(args: {
  refreshToken: string
  clientId: string
  clientSecret: string
}): Promise<
  | { kind: 'ok'; body: RefreshExchangeOk }
  | { kind: 'revoked'; status: number; body: string }
  | { kind: 'transient'; status: number; body: string }
> {
  let res: Response
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: args.refreshToken,
        client_id: args.clientId,
        client_secret: args.clientSecret,
      }),
    })
  } catch (err) {
    return { kind: 'transient', status: 0, body: (err as Error).message }
  }

  const text = await res.text().catch(() => '')

  if (res.status === 400 || res.status === 401) {
    // Per RFC 6749 §5.2, invalid_grant is 400. Google also uses 401 in some
    // edge cases. Either way, the user has revoked the grant or the token
    // is otherwise unusable — drop our row and force re-consent.
    return { kind: 'revoked', status: res.status, body: text }
  }
  if (!res.ok) {
    return { kind: 'transient', status: res.status, body: text }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'transient', status: res.status, body: 'non-JSON response' }
  }
  const body = parsed as Partial<RefreshExchangeOk>
  if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
    return { kind: 'transient', status: res.status, body: 'response missing access_token/expires_in' }
  }
  return { kind: 'ok', body: body as RefreshExchangeOk }
}

// POST /google/access-token — service-to-service. Mints a short-lived Google
// access token from the stored refresh token. Returns 200 on success with
// `{ access_token, expires_in, email? }` — `email` is the user's Google
// email (from `chat.users.email`, set at CF Access sign-in time) and is
// included so the pi-harness gccli/gdcli/gmcli shim can key its
// accounts.json entries without needing the email injected as an env var.
// `email` is omitted (with a warning logged) in the pathological state
// where an `pi.oauth_tokens` row exists but the matching `chat.users` row
// does not. 404 when the user has no token row; 401 with row-deletion when
// Google says the grant is revoked. Cache-Control: no-store — body contains
// a short-lived secret and per ROADMAP 0.B.3 we explicitly do not cache
// server-side.
oauthRoutes.post(
  '/google/access-token',
  serviceBearer({ tokenEnv: 'CONTROLLER_SERVICE_TOKEN' }),
  async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_body', message: 'request body must be JSON' }, 400)
    }
    if (typeof body !== 'object' || body === null) {
      return c.json({ error: 'invalid_body', message: 'request body must be a JSON object' }, 400)
    }
    const userId = (body as { userId?: unknown }).userId
    if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
      return c.json({ error: 'invalid_user_id', message: 'userId must be a UUID' }, 400)
    }

    const ct = await readRefreshTokenCt(userId, 'google').catch((err) => {
      console.error('[oauth] access-token read failed:', err)
      return null
    })
    if (!ct) {
      return c.json(
        { error: 'no_oauth_tokens', message: 'user has not connected Google' },
        404,
      )
    }

    let refreshToken: string
    try {
      refreshToken = decryptToken(ct)
    } catch (err) {
      // A decrypt failure means the row exists but the ciphertext is unusable
      // (key rotated without re-encrypt, or DB corruption). Surface 500;
      // operator decides whether to drop the row.
      console.error(`[oauth] decryptToken failed for user ${userId}:`, err)
      return c.json({ error: 'decrypt_failed' }, 500)
    }

    let cfg
    try {
      cfg = googleClientConfig()
    } catch (err) {
      console.error('[oauth] google client misconfigured:', (err as Error).message)
      return c.json({ error: 'oauth_not_configured' }, 500)
    }

    const result = await exchangeRefreshToken({
      refreshToken,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
    })

    if (result.kind === 'revoked') {
      console.warn(
        `[oauth] google rejected refresh token for user ${userId} ` +
          `(status=${result.status}); deleting row.`,
      )
      await deleteTokenRow(userId, 'google').catch((err) => {
        console.error('[oauth] failed to delete revoked token row:', err)
      })
      c.header('Cache-Control', 'no-store')
      return c.json(
        { error: 'oauth_revoked', message: 'user must reconnect Google' },
        401,
      )
    }
    if (result.kind === 'transient') {
      console.error(
        `[oauth] google token exchange transient failure ` +
          `(status=${result.status}): ${result.body}`,
      )
      c.header('Cache-Control', 'no-store')
      return c.json({ error: 'upstream_unavailable' }, 502)
    }

    // Success path. Bump last_refreshed_at and update scopes if Google
    // returned a (potentially different) set.
    const newScopes =
      typeof result.body.scope === 'string'
        ? result.body.scope.split(/\s+/).filter((s) => s.length > 0)
        : null
    await bumpRefreshedAt({ userId, provider: 'google', scopes: newScopes }).catch((err) => {
      // Don't fail the mint just because we couldn't update timestamps.
      console.error('[oauth] bumpRefreshedAt failed:', err)
    })

    // Look up the user's Google email. Best-effort: if the lookup fails
    // (DB blip) or the row is missing (pathological — an `pi.oauth_tokens`
    // row implies a `chat.users` row in steady state), log and omit the
    // field rather than failing the mint.
    const email = await readUserEmail(userId).catch((err) => {
      console.error('[oauth] readUserEmail failed:', err)
      return null
    })
    if (!email) {
      console.warn(
        `[oauth] /access-token: no chat.users.email for user ${userId}; ` +
          'omitting email from response',
      )
    }

    c.header('Cache-Control', 'no-store')
    const responseBody: { access_token: string; expires_in: number; email?: string } = {
      access_token: result.body.access_token,
      expires_in: result.body.expires_in,
    }
    if (email) responseBody.email = email
    return c.json(responseBody)
  },
)
