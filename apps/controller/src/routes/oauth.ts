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

import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { getPool, hasDatabase } from '../lib/db'
import { encryptToken, decryptToken } from '../lib/crypto'
import { requireSession } from '../middleware/session'

// ---------- Constants ----------

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

const SCOPES = [
  // Full Drive (read + write) so the gdcli connector can create/upload/edit
  // files, not just read. The same token powers the RAG crawl (read) and the
  // connectors (write). Widened from drive.readonly 2026-06-08 — existing users
  // must re-consent to pick up the write scope (include_granted_scopes adds it
  // incrementally).
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'openid',
  'email',
]

// 30 min. The consent flow for our RESTRICTED scopes (full Drive + Gmail
// modify) is multi-screen — account picker, "unverified app" interstitial,
// then a separate full-access checkbox per scope. A user who actually reads
// those "see, edit, and permanently delete" warnings can easily spend several
// minutes; a 5 min TTL was expiring the state mid-consent and dumping them on
// the callback's "invalid state" error (intermittent — only the slow readers
// hit it, fast clickers and retries came in under the wire). 30 min is still a
// short-lived signed token but comfortably outlasts a deliberate consent read.
const STATE_TTL_SEC = 30 * 60

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

// SEC-01 — per-sprite mint token.
//
// The Google-token mint endpoint (`POST /google/access-token`) has two
// callers with very different trust:
//   • rag-api's background crawl, which legitimately mints for ARBITRARY
//     users (no per-user session) — it holds CONTROLLER_SERVICE_TOKEN.
//   • each user's pi-harness, which must only ever mint ITS OWN user's
//     token.
//
// The harness lives in a per-user Sprite whose entire env is readable via
// `/proc` by the agent's `shell` tool (the SEC-01 attack). So any secret we
// give the Sprite to authenticate the mint is exfiltratable. The fix: the
// controller signs a per-USER mint token with CONTROLLER_MINT_SIGNING_KEY —
// a key that NEVER enters a Sprite — and injects it at provision time. The
// token encodes exactly one `userId`; presenting it mints only that user.
// Exfiltrating it from Sprite A therefore yields nothing beyond user A's own
// token (which the operator of Sprite A already has), and leaking
// HARNESS_JWT_SECRET (which IS in the Sprite) does NOT help — it is the wrong
// signer. This closes the cross-user mint without uid isolation (SEC-02).
//
// The signing key is read at call time (mirrors getStateSecret) so operator
// rotation takes effect without a re-import.
interface MintTokenClaims {
  userId: string
  exp: number
}

function getMintSigningKey(): string {
  const s = process.env.CONTROLLER_MINT_SIGNING_KEY
  if (!s) throw new Error('CONTROLLER_MINT_SIGNING_KEY not set (required to sign per-sprite mint tokens)')
  return s
}

// Mint a per-user token for injection into a Sprite at provision time.
// `ttlSec` defaults to 90 days: the token only authorizes minting its own
// user's Google token, and every `/api/session/start` re-bootstrap refreshes
// it, so a generous lifetime avoids a warm-but-stale-token failure mode.
export function signMintToken(args: { userId: string; ttlSec?: number }): string {
  const ttl = args.ttlSec ?? 90 * 24 * 60 * 60
  const now = Math.floor(Date.now() / 1000)
  const header = b64urlEncodeStr(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64urlEncodeStr(JSON.stringify({ userId: args.userId, exp: now + ttl }))
  const signing = `${header}.${payload}`
  return `${signing}.${hmac(signing, getMintSigningKey()).toString('base64url')}`
}

// Verify a per-sprite mint token. Throws on any malformation/mismatch/expiry.
function verifyMintToken(token: string): MintTokenClaims {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('malformed mint token')
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string]
  const expected = hmac(`${headerB64}.${payloadB64}`, getMintSigningKey())
  const provided = Buffer.from(sigB64, 'base64url')
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new Error('mint token signature invalid')
  }
  const claims = JSON.parse(
    Buffer.from(payloadB64, 'base64url').toString('utf8'),
  ) as MintTokenClaims
  if (typeof claims.userId !== 'string' || typeof claims.exp !== 'number') {
    throw new Error('mint token missing required fields')
  }
  if (claims.exp * 1000 < Date.now()) throw new Error('mint token expired')
  return claims
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

// ---------- Callback error page ----------

// The /callback runs in the user's BROWSER (Google 302s them here), so a bare
// `c.json({error}, 4xx)` renders a raw JSON blob with no way forward — the
// "it dumps you to an error" report. Render a small self-contained HTML page
// instead: a plain-language explanation plus a one-click "Try again" that
// re-enters the connect flow, so a transient failure (expired state, a denied
// click, Google withholding a refresh token) self-recovers without support.
//
// retryUrl: prefer a validated returnTo (the app page the user came from —
// re-landing there re-triggers the reconnect modal). When we can't trust the
// state (e.g. it failed to verify) fall back to OAUTH_RETRY_URL, then to the
// first allowed return host. If none resolves we omit the button and tell the
// user to return to the app manually.
function resolveRetryUrl(validatedReturnTo?: string | null): string | null {
  if (validatedReturnTo) return validatedReturnTo
  const explicit = process.env.OAUTH_RETRY_URL?.trim()
  if (explicit) return explicit
  const host = getAllowedReturnHosts()[0]
  return host ? `https://${host}/` : null
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) =>
      (
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as Record<
          string,
          string
        >
      )[ch] ?? ch,
  )
}

function oauthErrorPage(
  c: Context,
  opts: { status: ContentfulStatusCode; heading: string; detail: string; retryUrl: string | null },
): Response {
  const { status, heading, detail, retryUrl } = opts
  const button = retryUrl
    ? `<a class="btn" href="${escapeHtml(retryUrl)}">Try again</a>`
    : `<p class="muted">Return to the app and start the Google connection again.</p>`
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Couldn't connect Google</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, -apple-system, sans-serif; margin: 0;
         display: grid; place-items: center; min-height: 100vh; padding: 24px;
         background: Canvas; color: CanvasText; }
  .card { max-width: 30rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: .5rem 0; }
  .muted { opacity: .7; font-size: .9rem; }
  .btn { display: inline-block; margin-top: 1rem; padding: .6rem 1.25rem;
         border-radius: 8px; background: #2563eb; color: #fff;
         text-decoration: none; font-weight: 600; }
  .btn:hover { background: #1d4ed8; }
</style></head>
<body><div class="card">
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(detail)}</p>
  ${button}
</div></body></html>`
  return c.html(html, status)
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
    // Google bounced the user back with ?error= BEFORE we got a code — they
    // cancelled, or (the case we keep hitting) the consent was blocked because
    // our restricted scopes need an allowed/verified account. Log it: this is
    // the branch that previously returned silently, so the actual Google reason
    // never reached the logs. `access_denied` / `org_internal` are the common
    // values; capture whatever Google sent verbatim.
    console.warn(`[oauth] google callback denied: error=${errParam}`)
    const denied = errParam === 'access_denied'
    return oauthErrorPage(c, {
      status: 400,
      heading: denied ? 'Google connection cancelled' : "Google couldn't complete the connection",
      detail: denied
        ? 'The connection was cancelled or your account is not permitted to grant these permissions. Make sure you are signed in with the correct account, then try again.'
        : `Google returned an error (${errParam}). Please try again.`,
      retryUrl: resolveRetryUrl(),
    })
  }
  if (!code || !state) {
    console.warn('[oauth] callback missing code or state')
    return oauthErrorPage(c, {
      status: 400,
      heading: "Google couldn't complete the connection",
      detail: 'The response from Google was incomplete. Please try connecting again.',
      retryUrl: resolveRetryUrl(),
    })
  }

  let payload: StatePayload
  try {
    payload = verifyState(state)
  } catch (err) {
    // Most often the state simply expired mid-consent (see STATE_TTL_SEC). Tell
    // the user that in plain language rather than the cryptic "invalid state".
    console.warn('[oauth] state verify failed:', (err as Error).message)
    return oauthErrorPage(c, {
      status: 400,
      heading: 'Your connection link expired',
      detail:
        'The Google connection took too long to complete, so the secure link timed out. Please start the connection again — it only takes a moment.',
      retryUrl: resolveRetryUrl(),
    })
  }

  let cfg
  try {
    cfg = googleClientConfig()
  } catch (err) {
    console.error('[oauth] google client misconfigured:', (err as Error).message)
    return oauthErrorPage(c, {
      status: 500,
      heading: 'Google sign-in is misconfigured',
      detail: 'This is on our end, not yours. Please let the team know if it persists.',
      retryUrl: resolveRetryUrl(payload.returnTo),
    })
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
    return oauthErrorPage(c, {
      status: 502,
      heading: "Couldn't reach Google",
      detail: 'We had trouble talking to Google. Please try again in a moment.',
      retryUrl: resolveRetryUrl(payload.returnTo),
    })
  }

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '')
    console.error(`[oauth] google token exchange ${tokenRes.status}: ${body}`)
    return oauthErrorPage(c, {
      status: 502,
      heading: "Google couldn't complete the connection",
      detail: 'Google rejected the sign-in. Please try connecting again.',
      retryUrl: resolveRetryUrl(payload.returnTo),
    })
  }

  const tokenBody = (await tokenRes.json().catch(() => null)) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
    token_type?: string
  } | null

  if (!tokenBody) {
    console.error('[oauth] google token response was not JSON')
    return oauthErrorPage(c, {
      status: 502,
      heading: "Google couldn't complete the connection",
      detail: 'We got an unexpected response from Google. Please try again.',
      retryUrl: resolveRetryUrl(payload.returnTo),
    })
  }

  if (!tokenBody.refresh_token) {
    // We forced prompt=consent, so this should be impossible. If it happens
    // it's almost always because the user previously consented and Google
    // is suppressing the new refresh token despite our prompt — known
    // footgun. Surface a clear, actionable error rather than upserting an
    // empty row.
    console.error(
      `[oauth] google response had no refresh_token for user ${payload.userId}; ` +
        `scopes=${tokenBody.scope ?? '<none>'}`,
    )
    return oauthErrorPage(c, {
      status: 500,
      heading: 'Google needs you to reconnect',
      detail:
        "Google didn't return the credential we need. Open myaccount.google.com/permissions, remove access for the app, then click Try again.",
      retryUrl: resolveRetryUrl(payload.returnTo),
    })
  }

  const scopes = (tokenBody.scope ?? '').split(/\s+/).filter((s) => s.length > 0)

  let ciphertext: string
  try {
    ciphertext = encryptToken(tokenBody.refresh_token)
  } catch (err) {
    console.error('[oauth] encryptToken failed:', err)
    return oauthErrorPage(c, {
      status: 500,
      heading: 'Something went wrong on our end',
      detail: 'We connected to Google but failed to store the credential. Please try again.',
      retryUrl: resolveRetryUrl(payload.returnTo),
    })
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
    return oauthErrorPage(c, {
      status: 500,
      heading: 'Something went wrong on our end',
      detail: 'We connected to Google but failed to save it. Please try again.',
      retryUrl: resolveRetryUrl(payload.returnTo),
    })
  }

  return c.redirect(payload.returnTo, 302)
})

// /status — JWT-gated. Existence-only check: row present ⇒ connected.
// Cheap, but doesn't catch revocation / decrypt failure / scope drift, so
// the SPA gate uses /health (below) instead. Kept for debugging + admin
// views.
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

// /health — JWT-gated. Real round-trip to Google to prove the stored grant
// still mints. Replaces /status as the SPA gate's source of truth: a row
// existing only proves "this user once consented", not that the grant
// still works. Without /health, a revoked refresh_token / rotated enc-key
// / missing scope leaves the user permanently past the gate with a
// quietly broken harness.
//
// Reasons returned with `ok: false`:
//   no_grant       — no row; user has never consented (or row was deleted)
//   revoked        — Google rejected the refresh; row deleted, must reconsent
//   decrypt_failed — row ciphertext unusable (likely OAUTH_TOKEN_ENC_KEY
//                    rotated). Row preserved for operator inspection; user
//                    re-consenting overwrites it via /callback's UPSERT.
//   transient      — Google 5xx / network blip. Row preserved. SPA should
//                    show retry, NOT the consent screen.
//   misconfigured  — server missing GOOGLE_OAUTH_CLIENT_ID/SECRET.
//
// All non-error responses are 200 so the SPA can branch on `reason` without
// inspecting status codes. Cache-Control: no-store because we just minted
// (and discarded) a real access token.
oauthRoutes.get('/google/health', requireSession, async (c) => {
  c.header('Cache-Control', 'no-store')
  const user = c.get('user')

  const ct = await readRefreshTokenCt(user.id, 'google').catch((err) => {
    console.error('[oauth] /health refresh-token read failed:', err)
    return null
  })
  if (!ct) {
    return c.json({ ok: false, reason: 'no_grant' as const })
  }

  let refreshToken: string
  try {
    refreshToken = decryptToken(ct)
  } catch (err) {
    console.error(`[oauth] /health decryptToken failed for user ${user.id}:`, err)
    return c.json({ ok: false, reason: 'decrypt_failed' as const })
  }

  let cfg
  try {
    cfg = googleClientConfig()
  } catch (err) {
    console.error('[oauth] /health google client misconfigured:', (err as Error).message)
    return c.json({ ok: false, reason: 'misconfigured' as const }, 503)
  }

  const result = await exchangeRefreshToken({
    refreshToken,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
  })

  if (result.kind === 'revoked') {
    console.warn(
      `[oauth] /health: google rejected refresh token for user ${user.id} ` +
        `(status=${result.status}); deleting row.`,
    )
    await deleteTokenRow(user.id, 'google').catch((err) => {
      console.error('[oauth] /health failed to delete revoked token row:', err)
    })
    return c.json({ ok: false, reason: 'revoked' as const })
  }
  if (result.kind === 'transient') {
    console.error(
      `[oauth] /health: google token exchange transient failure ` +
        `(status=${result.status}): ${result.body}`,
    )
    return c.json({ ok: false, reason: 'transient' as const })
  }

  // Successful mint. Bump last_refreshed_at + sync scopes so /status reflects
  // reality, then discard the access token (the SPA never sees it).
  const newScopes =
    typeof result.body.scope === 'string'
      ? result.body.scope.split(/\s+/).filter((s) => s.length > 0)
      : null
  await bumpRefreshedAt({ userId: user.id, provider: 'google', scopes: newScopes }).catch(
    (err) => {
      console.error('[oauth] /health bumpRefreshedAt failed:', err)
    },
  )

  // Re-read the row so the response carries the freshly-bumped values.
  const row = await readTokenRow(user.id, 'google').catch(() => null)
  return c.json({
    ok: true as const,
    scopes: row?.scopes ?? newScopes ?? [],
    granted_at: row?.granted_at ?? null,
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
// Auth is enforced inside the handler (not via the serviceBearer middleware)
// because the two callers authenticate differently — see the SEC-01 block.
oauthRoutes.post(
  '/google/access-token',
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

    // SEC-01 — dual-mode auth, by caller trust:
    //
    //  (a) Per-sprite mint token (`x-mint-token`): a controller-signed token
    //      that encodes exactly one userId. The pi-harness presents this. The
    //      mint is SCOPED — the requested `userId` MUST equal the token's
    //      userId (403 otherwise). Because the signing key never enters a
    //      Sprite, a prompt-injected agent that exfiltrates the Sprite env
    //      (the SEC-01 attack) can mint only its own user's token.
    //
    //  (b) Service bearer (`Authorization: Bearer <CONTROLLER_SERVICE_TOKEN>`):
    //      the arbitrary-userId path, for rag-api's background crawl, which
    //      has no per-user session. This token is NEVER injected into a Sprite
    //      (removed from bootstrap.ts), so it isn't reachable from the agent.
    //
    // A request must satisfy exactly one path. The mint token takes
    // precedence when present; otherwise we fall through to the service
    // bearer.
    const mintToken = c.req.header('x-mint-token')
    if (mintToken) {
      let claims: MintTokenClaims
      try {
        claims = verifyMintToken(mintToken)
      } catch {
        return c.json(
          { error: 'invalid_mint_token', message: 'x-mint-token is not a valid mint token' },
          401,
        )
      }
      if (claims.userId !== userId) {
        return c.json(
          { error: 'user_id_mismatch', message: 'mint token userId does not match requested userId' },
          403,
        )
      }
    } else {
      // Service-bearer path (rag-api). Constant-time compare; fail closed when
      // the token is unset (503, mirroring the serviceBearer middleware).
      const expected = process.env.CONTROLLER_SERVICE_TOKEN ?? ''
      if (!expected) {
        return c.json({ error: 'service endpoint disabled' }, 503)
      }
      const auth = c.req.header('authorization')
      const m = auth && /^Bearer\s+(.+)$/i.exec(auth)
      const provided = m ? m[1]! : ''
      const pb = Buffer.from(provided, 'utf8')
      const eb = Buffer.from(expected, 'utf8')
      if (pb.length !== eb.length || !timingSafeEqual(pb, eb)) {
        return c.json({ error: 'unauthenticated' }, 401)
      }
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
