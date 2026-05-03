// Drive OAuth access-token provider. Two strategies:
//
//   OAUTH_PROVIDER=env        Static refresh token in env. The single-user
//                             dev path until the controller's mint endpoint
//                             lands. Same Google OAuth client as the
//                             pi-harness gcal connector.
//   OAUTH_PROVIDER=controller Calls the controller's
//                             /api/oauth/google/access-token. The prod path
//                             once Phase 3.2 of ROADMAP.md is live.
//
// Returns an access token usable as a Bearer for googleapis Drive calls.
// Tokens are cached per-user in-process for (expires_in - 60s).

interface CachedToken {
  token: string
  expiresAt: number // ms epoch
}

const cache = new Map<string, CachedToken>()

const PROVIDER = (process.env.OAUTH_PROVIDER ?? 'env').toLowerCase()
const FALLBACK_USER_ID = process.env.OAUTH_FALLBACK_USER_ID ?? ''

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? ''
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? ''
const FALLBACK_REFRESH = process.env.GOOGLE_DRIVE_REFRESH_TOKEN ?? ''

const CONTROLLER_BASE_URL = (process.env.CONTROLLER_BASE_URL ?? '').replace(/\/+$/, '')
const CONTROLLER_SERVICE_TOKEN = process.env.CONTROLLER_SERVICE_TOKEN ?? ''

export class OAuthError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
  }
}

export async function getDriveAccessToken(userId: string): Promise<string> {
  const cached = cache.get(userId)
  if (cached && cached.expiresAt > Date.now()) return cached.token

  let token: string
  let expiresInSec: number
  if (PROVIDER === 'controller') {
    ;({ token, expiresInSec } = await mintFromController(userId))
  } else {
    ;({ token, expiresInSec } = await mintFromEnv(userId))
  }

  // Refresh 60s before expiry.
  cache.set(userId, { token, expiresAt: Date.now() + (expiresInSec - 60) * 1000 })
  return token
}

async function mintFromEnv(userId: string): Promise<{ token: string; expiresInSec: number }> {
  // For now we only know one user. Per-user refresh tokens via env
  // (GOOGLE_DRIVE_REFRESH_TOKEN_<userId>) would scale to N before the
  // controller lands but isn't worth the complexity for the dev path.
  if (!FALLBACK_USER_ID || userId !== FALLBACK_USER_ID) {
    throw new OAuthError(
      `no env-mode refresh token configured for user ${userId} (set OAUTH_FALLBACK_USER_ID + GOOGLE_DRIVE_REFRESH_TOKEN)`,
    )
  }
  if (!CLIENT_ID || !CLIENT_SECRET || !FALLBACK_REFRESH) {
    throw new OAuthError('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_DRIVE_REFRESH_TOKEN not set')
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: FALLBACK_REFRESH,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    throw new OAuthError(`google token exchange ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!body.access_token) throw new OAuthError('google token response missing access_token')
  return { token: body.access_token, expiresInSec: body.expires_in ?? 3600 }
}

async function mintFromController(userId: string): Promise<{ token: string; expiresInSec: number }> {
  if (!CONTROLLER_BASE_URL) throw new OAuthError('CONTROLLER_BASE_URL not set')
  if (!CONTROLLER_SERVICE_TOKEN) throw new OAuthError('CONTROLLER_SERVICE_TOKEN not set')
  const res = await fetch(`${CONTROLLER_BASE_URL}/api/oauth/google/access-token`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${CONTROLLER_SERVICE_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ userId }),
  })
  if (!res.ok) {
    throw new OAuthError(`controller mint ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!body.access_token) throw new OAuthError('controller response missing access_token')
  return { token: body.access_token, expiresInSec: body.expires_in ?? 3600 }
}
