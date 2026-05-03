// Mirror of api/src/lib/oauth.ts. Worker calls Google directly (env
// mode) or the controller (controller mode). Same shape so swapping
// providers is one env change.

interface CachedToken {
  token: string
  expiresAt: number
}

const cache = new Map<string, CachedToken>()

const PROVIDER = (process.env.OAUTH_PROVIDER ?? 'env').toLowerCase()
const FALLBACK_USER_ID = process.env.OAUTH_FALLBACK_USER_ID ?? ''

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? ''
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? ''
const FALLBACK_REFRESH = process.env.GOOGLE_DRIVE_REFRESH_TOKEN ?? ''

const CONTROLLER_BASE_URL = (process.env.CONTROLLER_BASE_URL ?? '').replace(/\/+$/, '')
const CONTROLLER_SERVICE_TOKEN = process.env.CONTROLLER_SERVICE_TOKEN ?? ''

export class OAuthError extends Error {}

// chatUserId here is rag.users.chat_user_id — the value the controller
// will key its refresh-token store on once Phase 3.2 lands.
export async function getDriveAccessToken(chatUserId: string): Promise<string> {
  const cached = cache.get(chatUserId)
  if (cached && cached.expiresAt > Date.now()) return cached.token

  const minted = PROVIDER === 'controller' ? await mintFromController(chatUserId) : await mintFromEnv(chatUserId)
  cache.set(chatUserId, { token: minted.token, expiresAt: Date.now() + (minted.expiresInSec - 60) * 1000 })
  return minted.token
}

async function mintFromEnv(chatUserId: string): Promise<{ token: string; expiresInSec: number }> {
  if (!FALLBACK_USER_ID || chatUserId !== FALLBACK_USER_ID) {
    throw new OAuthError(
      `no env-mode refresh token configured for user ${chatUserId} (set OAUTH_FALLBACK_USER_ID + GOOGLE_DRIVE_REFRESH_TOKEN)`,
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
  if (!res.ok) throw new OAuthError(`google token exchange ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!body.access_token) throw new OAuthError('google token response missing access_token')
  return { token: body.access_token, expiresInSec: body.expires_in ?? 3600 }
}

async function mintFromController(chatUserId: string): Promise<{ token: string; expiresInSec: number }> {
  if (!CONTROLLER_BASE_URL) throw new OAuthError('CONTROLLER_BASE_URL not set')
  if (!CONTROLLER_SERVICE_TOKEN) throw new OAuthError('CONTROLLER_SERVICE_TOKEN not set')
  const res = await fetch(`${CONTROLLER_BASE_URL}/api/oauth/google/access-token`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${CONTROLLER_SERVICE_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ userId: chatUserId }),
  })
  if (!res.ok) throw new OAuthError(`controller mint ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!body.access_token) throw new OAuthError('controller response missing access_token')
  return { token: body.access_token, expiresInSec: body.expires_in ?? 3600 }
}
