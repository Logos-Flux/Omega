import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { Hono } from 'hono'

// Fixed secrets for the test process. Keep these out of any production env.
const TEST_HARNESS_SECRET = 'test-harness-secret-do-not-ship'
const TEST_ENC_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

// ---------- Module mocks ----------
// We mock the DB and the requireSession middleware before importing the
// oauth routes. Mocks must be set up at top level (mock.module is hoisted-
// ish in bun:test).

interface MockQueryResult {
  rows: Record<string, unknown>[]
  rowCount: number
}

const mockPool = {
  query: mock(
    async (_sql: string, _params?: unknown[]): Promise<MockQueryResult> => ({ rows: [], rowCount: 0 }),
  ),
}

mock.module('../lib/db', () => ({
  getPool: () => mockPool,
  hasDatabase: true,
}))

mock.module('../middleware/session', () => ({
  requireSession: async (
    c: { set: (k: string, v: unknown) => void; req: { header: (k: string) => string | undefined } },
    next: () => Promise<void>,
  ) => {
    const userId = c.req.header('x-test-user-id') ?? '11111111-2222-3333-4444-555555555555'
    c.set('user', {
      id: userId,
      email: 'test@example.com',
      name: 'Test',
      picture: null,
      sub: 'test-sub',
      releaseChannel: 'alpha',
    })
    await next()
  },
}))

// Now import — module-level state in oauth.ts will see the mocks.
const oauth = await import('./oauth')

// Save and restore globalThis.fetch — we override it for the Google
// token exchange in /callback tests.
const originalFetch = globalThis.fetch

beforeEach(() => {
  process.env.HARNESS_JWT_SECRET = TEST_HARNESS_SECRET
  process.env.OAUTH_TOKEN_ENC_KEY = TEST_ENC_KEY
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret'
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/oauth/google/callback'
  // ALLOWED_RETURN_HOSTS used to be hardcoded in oauth.ts; it's now env-driven.
  // Set the legacy values here so the existing test cases continue to exercise
  // the same allow/deny matrix.
  process.env.ALLOWED_RETURN_HOSTS = 'chat.omega.ai,omega.ai'
  delete process.env.NODE_ENV

  // Reset DB mock between tests.
  mockPool.query.mockReset()
  mockPool.query.mockImplementation(async () => ({ rows: [], rowCount: 0 }))
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function makeApp() {
  const app = new Hono()
  app.route('/api/oauth', oauth.oauthRoutes)
  return app
}

// ---------- validateReturnTo ----------

describe('validateReturnTo', () => {
  test('accepts https://chat.omega.ai/path in production', () => {
    const r = oauth.validateReturnTo('https://chat.omega.ai/chat/', { allowLocalhost: false })
    expect(r).toBe('https://chat.omega.ai/chat/')
  })

  test('accepts https://omega.ai/something in production', () => {
    const r = oauth.validateReturnTo('https://omega.ai/welcome', { allowLocalhost: false })
    expect(r).toBe('https://omega.ai/welcome')
  })

  test('rejects evil.com', () => {
    const r = oauth.validateReturnTo('https://evil.com/', { allowLocalhost: false })
    expect(r).toBeNull()
  })

  test('rejects look-alike host chat.omega.ai.evil.com', () => {
    const r = oauth.validateReturnTo('https://chat.omega.ai.evil.com/', { allowLocalhost: false })
    expect(r).toBeNull()
  })

  test('rejects http://chat.omega.ai (non-https) in production', () => {
    const r = oauth.validateReturnTo('http://chat.omega.ai/', { allowLocalhost: false })
    expect(r).toBeNull()
  })

  test('rejects localhost in production mode', () => {
    const r = oauth.validateReturnTo('http://localhost:5173/', { allowLocalhost: false })
    expect(r).toBeNull()
  })

  test('accepts localhost in dev mode', () => {
    const r = oauth.validateReturnTo('http://localhost:5173/chat/', { allowLocalhost: true })
    expect(r).toBe('http://localhost:5173/chat/')
  })

  test('accepts 127.0.0.1 in dev mode', () => {
    const r = oauth.validateReturnTo('http://127.0.0.1:3000/', { allowLocalhost: true })
    expect(r).toBe('http://127.0.0.1:3000/')
  })

  test('rejects URLs with embedded credentials', () => {
    const r = oauth.validateReturnTo('https://user:pw@chat.omega.ai/', { allowLocalhost: false })
    expect(r).toBeNull()
  })

  test('rejects non-string input', () => {
    expect(oauth.validateReturnTo(undefined, { allowLocalhost: false })).toBeNull()
    expect(oauth.validateReturnTo(null, { allowLocalhost: false })).toBeNull()
    expect(oauth.validateReturnTo(42, { allowLocalhost: false })).toBeNull()
  })

  test('rejects malformed URL', () => {
    expect(oauth.validateReturnTo('not-a-url', { allowLocalhost: true })).toBeNull()
  })
})

// ---------- signState / verifyState ----------

describe('state HMAC', () => {
  test('signs and verifies round-trip', () => {
    const state = oauth.signState({
      userId: 'user-1',
      returnTo: 'https://chat.omega.ai/',
    })
    const payload = oauth.verifyState(state)
    expect(payload.userId).toBe('user-1')
    expect(payload.returnTo).toBe('https://chat.omega.ai/')
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect(payload.nonce.length).toBeGreaterThan(0)
  })

  test('tampered body is rejected', () => {
    const state = oauth.signState({ userId: 'user-1', returnTo: 'https://chat.omega.ai/' })
    const [body, sig] = state.split('.') as [string, string]
    // Decode, mutate the userId, re-encode body — keep original sig.
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    decoded.userId = 'attacker'
    const tamperedBody = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    const tampered = `${tamperedBody}.${sig}`
    expect(() => oauth.verifyState(tampered)).toThrow(/signature/)
  })

  test('tampered signature is rejected', () => {
    const state = oauth.signState({ userId: 'user-1', returnTo: 'https://chat.omega.ai/' })
    const [body] = state.split('.') as [string, string]
    // 32 zero bytes in base64url
    const fakeSig = Buffer.alloc(32, 0).toString('base64url')
    expect(() => oauth.verifyState(`${body}.${fakeSig}`)).toThrow(/signature/)
  })

  test('expired state is rejected', () => {
    const state = oauth.signState({
      userId: 'user-1',
      returnTo: 'https://chat.omega.ai/',
      ttlSec: -1, // already expired
    })
    expect(() => oauth.verifyState(state)).toThrow(/expired/)
  })

  test('malformed state (no dot) is rejected', () => {
    expect(() => oauth.verifyState('garbage')).toThrow(/malformed/)
  })
})

// ---------- buildGoogleAuthUrl ----------

describe('buildGoogleAuthUrl', () => {
  test('produces a Google consent URL with all required params', () => {
    const url = oauth.buildGoogleAuthUrl({
      state: 'state-value',
      clientId: 'cid',
      redirectUri: 'https://example.com/cb',
    })
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(u.searchParams.get('client_id')).toBe('cid')
    expect(u.searchParams.get('redirect_uri')).toBe('https://example.com/cb')
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('prompt')).toBe('consent')
    expect(u.searchParams.get('include_granted_scopes')).toBe('true')
    expect(u.searchParams.get('state')).toBe('state-value')
    const scope = u.searchParams.get('scope') ?? ''
    expect(scope).toContain('https://www.googleapis.com/auth/drive.readonly')
    expect(scope).toContain('https://www.googleapis.com/auth/calendar')
    expect(scope).toContain('https://www.googleapis.com/auth/gmail.modify')
    expect(scope).toContain('openid')
    expect(scope).toContain('email')
  })
})

// ---------- /start ----------

describe('GET /api/oauth/google/start', () => {
  test('rejects missing return_to', async () => {
    const app = makeApp()
    const res = await app.request('/api/oauth/google/start')
    expect(res.status).toBe(400)
  })

  test('rejects evil return_to', async () => {
    const app = makeApp()
    const res = await app.request(
      '/api/oauth/google/start?return_to=' + encodeURIComponent('https://evil.com/'),
    )
    expect(res.status).toBe(400)
  })

  test('redirects to Google with signed state for valid return_to', async () => {
    const app = makeApp()
    const res = await app.request(
      '/api/oauth/google/start?return_to=' + encodeURIComponent('https://chat.omega.ai/chat/'),
      {
        headers: { 'x-test-user-id': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
      },
    )
    expect(res.status).toBe(302)
    const loc = res.headers.get('location') ?? ''
    expect(loc.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true)
    const u = new URL(loc)
    const state = u.searchParams.get('state') ?? ''
    const payload = oauth.verifyState(state)
    expect(payload.userId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(payload.returnTo).toBe('https://chat.omega.ai/chat/')
  })

  test('rejects localhost return_to in production', async () => {
    process.env.NODE_ENV = 'production'
    const app = makeApp()
    const res = await app.request(
      '/api/oauth/google/start?return_to=' + encodeURIComponent('http://localhost:5173/'),
    )
    expect(res.status).toBe(400)
  })

  test('accepts localhost return_to in dev', async () => {
    process.env.NODE_ENV = 'development'
    const app = makeApp()
    const res = await app.request(
      '/api/oauth/google/start?return_to=' + encodeURIComponent('http://localhost:5173/chat/'),
    )
    expect(res.status).toBe(302)
  })
})

// ---------- /callback ----------

describe('GET /api/oauth/google/callback', () => {
  test('rejects missing code', async () => {
    const app = makeApp()
    const state = oauth.signState({ userId: 'u', returnTo: 'https://chat.omega.ai/' })
    const res = await app.request(`/api/oauth/google/callback?state=${encodeURIComponent(state)}`)
    expect(res.status).toBe(400)
  })

  test('rejects missing state', async () => {
    const app = makeApp()
    const res = await app.request('/api/oauth/google/callback?code=xyz')
    expect(res.status).toBe(400)
  })

  test('rejects tampered state', async () => {
    const app = makeApp()
    const state = oauth.signState({ userId: 'u', returnTo: 'https://chat.omega.ai/' })
    const [body] = state.split('.') as [string, string]
    const fakeSig = Buffer.alloc(32, 0).toString('base64url')
    const bad = `${body}.${fakeSig}`
    const res = await app.request(
      `/api/oauth/google/callback?code=xyz&state=${encodeURIComponent(bad)}`,
    )
    expect(res.status).toBe(400)
  })

  test('happy path: exchanges code, upserts row, redirects to return_to', async () => {
    const userId = 'cccccccc-1111-2222-3333-444444444444'
    const returnTo = 'https://chat.omega.ai/chat/'
    const state = oauth.signState({ userId, returnTo })

    // Mock Google's token endpoint.
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      const target = typeof url === 'string' ? url : url.toString()
      expect(target).toBe('https://oauth2.googleapis.com/token')
      expect(init?.method).toBe('POST')
      const body = init?.body as URLSearchParams
      expect(body.get('code')).toBe('the-code')
      expect(body.get('grant_type')).toBe('authorization_code')
      return new Response(
        JSON.stringify({
          access_token: 'ya29.access',
          refresh_token: '1//0gREFRESHTOKEN',
          expires_in: 3599,
          scope:
            'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/calendar openid email',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    // DB mock: capture the upsert call.
    const calls: Array<{ sql: string; params: unknown[] }> = []
    mockPool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] })
      return { rows: [], rowCount: 1 }
    })

    const app = makeApp()
    const res = await app.request(
      `/api/oauth/google/callback?code=the-code&state=${encodeURIComponent(state)}`,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(returnTo)

    expect(calls.length).toBe(1)
    const c = calls[0]!
    expect(c.sql).toContain('INSERT INTO pi.oauth_tokens')
    expect(c.params[0]).toBe(userId)
    expect(c.params[1]).toBe('google')
    // params[2] is the encrypted refresh token — must NOT equal the plaintext.
    expect(typeof c.params[2]).toBe('string')
    expect(c.params[2]).not.toBe('1//0gREFRESHTOKEN')
    // params[3] is the scope array.
    expect(c.params[3]).toEqual([
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/calendar',
      'openid',
      'email',
    ])
  })

  test('returns clear error when google response has no refresh_token', async () => {
    const state = oauth.signState({ userId: 'u', returnTo: 'https://chat.omega.ai/' })

    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          access_token: 'ya29.access',
          // no refresh_token
          expires_in: 3599,
          scope: 'openid email',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const app = makeApp()
    const res = await app.request(
      `/api/oauth/google/callback?code=xxx&state=${encodeURIComponent(state)}`,
    )
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/refresh_token/i)
  })

  test('surfaces google token-endpoint failures as 502', async () => {
    const state = oauth.signState({ userId: 'u', returnTo: 'https://chat.omega.ai/' })

    globalThis.fetch = mock(async () => {
      return new Response('invalid_grant', { status: 400 })
    }) as unknown as typeof fetch

    const app = makeApp()
    const res = await app.request(
      `/api/oauth/google/callback?code=xxx&state=${encodeURIComponent(state)}`,
    )
    expect(res.status).toBe(502)
  })

  test('surfaces google ?error= param', async () => {
    const app = makeApp()
    const res = await app.request('/api/oauth/google/callback?error=access_denied')
    expect(res.status).toBe(400)
  })
})

// ---------- /status ----------

describe('GET /api/oauth/google/status', () => {
  test('returns connected:false when no row exists', async () => {
    mockPool.query.mockImplementation(async () => ({ rows: [], rowCount: 0 }))
    const app = makeApp()
    const res = await app.request('/api/oauth/google/status')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { google: { connected: boolean; scopes: string[]; granted_at: string | null } }
    expect(body.google.connected).toBe(false)
    expect(body.google.scopes).toEqual([])
    expect(body.google.granted_at).toBeNull()
  })

  test('returns connected:true with scopes when row exists', async () => {
    mockPool.query.mockImplementation(async () => ({
      rows: [
        {
          user_id: 'u',
          provider: 'google',
          scopes: ['https://www.googleapis.com/auth/drive.readonly', 'openid', 'email'],
          granted_at: '2026-04-30T12:00:00.000Z',
          last_refreshed_at: null,
        },
      ],
      rowCount: 1,
    }))
    const app = makeApp()
    const res = await app.request('/api/oauth/google/status')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      google: { connected: boolean; scopes: string[]; granted_at: string | null }
    }
    expect(body.google.connected).toBe(true)
    expect(body.google.scopes).toContain('https://www.googleapis.com/auth/drive.readonly')
    expect(body.google.granted_at).toBe('2026-04-30T12:00:00.000Z')
  })

  test('does not leak refresh_token even if DB returns one (smoke check)', async () => {
    // Belt and suspenders: even if a future refactor accidentally selected
    // refresh_token, the response shape must not include it.
    mockPool.query.mockImplementation(async () => ({
      rows: [
        {
          user_id: 'u',
          provider: 'google',
          scopes: ['openid'],
          granted_at: '2026-04-30T12:00:00.000Z',
          last_refreshed_at: null,
          refresh_token: 'SHOULD_NEVER_LEAK',
        },
      ],
      rowCount: 1,
    }))
    const app = makeApp()
    const res = await app.request('/api/oauth/google/status')
    const text = await res.text()
    expect(text).not.toContain('SHOULD_NEVER_LEAK')
  })
})

// ---------- POST /access-token (Phase 0.B.3) ----------

const VALID_USER_ID = 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee'
const TEST_SERVICE_TOKEN = 'test-controller-service-token-do-not-ship'

/**
 * Build a mock query implementation that:
 *   - returns the given encrypted refresh_token on SELECT refresh_token
 *   - returns the given email on SELECT email FROM chat.users (or no row
 *     when `userEmail` is null — exercises the pathological-state branch)
 *   - records every call to a `calls` array
 *   - succeeds on UPDATE/DELETE with rowCount 1
 */
function buildAccessTokenQueryMock(
  refreshTokenCt: string | null,
  calls: Array<{ sql: string; params: unknown[] }>,
  userEmail: string | null = 'user@example.com',
) {
  return async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] })
    if (/^\s*SELECT refresh_token/i.test(sql)) {
      if (refreshTokenCt === null) return { rows: [], rowCount: 0 }
      return { rows: [{ refresh_token: refreshTokenCt }], rowCount: 1 }
    }
    if (/^\s*SELECT email FROM chat\.users/i.test(sql)) {
      if (userEmail === null) return { rows: [], rowCount: 0 }
      return { rows: [{ email: userEmail }], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  }
}

describe('POST /api/oauth/google/access-token (service-bearer)', () => {
  // Each test sets the bearer; some clear it.
  beforeEach(() => {
    process.env.CONTROLLER_SERVICE_TOKEN = TEST_SERVICE_TOKEN
  })

  test('401 when Authorization header missing', async () => {
    const app = makeApp()
    const res = await app.request('/api/oauth/google/access-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: VALID_USER_ID }),
    })
    expect(res.status).toBe(401)
  })

  test('401 when bearer token is wrong', async () => {
    const app = makeApp()
    const res = await app.request('/api/oauth/google/access-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer not-the-right-token',
      },
      body: JSON.stringify({ userId: VALID_USER_ID }),
    })
    expect(res.status).toBe(401)
  })

  test('503 when CONTROLLER_SERVICE_TOKEN is not configured', async () => {
    delete process.env.CONTROLLER_SERVICE_TOKEN
    const app = makeApp()
    const res = await app.request('/api/oauth/google/access-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_SERVICE_TOKEN}`,
      },
      body: JSON.stringify({ userId: VALID_USER_ID }),
    })
    expect(res.status).toBe(503)
  })

  test('400 when userId is missing or invalid', async () => {
    const app = makeApp()
    const res1 = await app.request('/api/oauth/google/access-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_SERVICE_TOKEN}`,
      },
      body: JSON.stringify({}),
    })
    expect(res1.status).toBe(400)

    const res2 = await app.request('/api/oauth/google/access-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_SERVICE_TOKEN}`,
      },
      body: JSON.stringify({ userId: 'not-a-uuid' }),
    })
    expect(res2.status).toBe(400)

    const res3 = await app.request('/api/oauth/google/access-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_SERVICE_TOKEN}`,
      },
      body: 'not json at all',
    })
    expect(res3.status).toBe(400)
  })

  test('404 when user has no oauth_tokens row', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    mockPool.query.mockImplementation(buildAccessTokenQueryMock(null, calls))

    const app = makeApp()
    const res = await app.request('/api/oauth/google/access-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_SERVICE_TOKEN}`,
      },
      body: JSON.stringify({ userId: VALID_USER_ID }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('no_oauth_tokens')
  })

  test('200 happy path: returns access_token, no refresh_token, no-store, last_refreshed_at updated', async () => {
    // Encrypt a known plaintext via the real crypto module — round-trips
    // through decryptToken inside the handler.
    const { encryptToken } = await import('../lib/crypto')
    const ct = encryptToken('refresh-token-plaintext')

    const calls: Array<{ sql: string; params: unknown[] }> = []
    mockPool.query.mockImplementation(buildAccessTokenQueryMock(ct, calls))

    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      const target = typeof url === 'string' ? url : url.toString()
      expect(target).toBe('https://oauth2.googleapis.com/token')
      const reqBody = init?.body as URLSearchParams
      expect(reqBody.get('grant_type')).toBe('refresh_token')
      expect(reqBody.get('refresh_token')).toBe('refresh-token-plaintext')
      expect(reqBody.get('client_id')).toBe('test-client-id.apps.googleusercontent.com')
      expect(reqBody.get('client_secret')).toBe('test-client-secret')
      return new Response(
        JSON.stringify({
          access_token: 'ya29.fresh-access',
          expires_in: 3599,
          scope: 'https://www.googleapis.com/auth/drive.readonly openid email',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const app = makeApp()
    const res = await app.request('/api/oauth/google/access-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_SERVICE_TOKEN}`,
      },
      body: JSON.stringify({ userId: VALID_USER_ID }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')

    const text = await res.text()
    const body = JSON.parse(text) as {
      access_token: string
      expires_in: number
      email?: string
      refresh_token?: string
    }
    expect(body.access_token).toBe('ya29.fresh-access')
    expect(body.expires_in).toBe(3599)
    expect(body.refresh_token).toBeUndefined()
    // Email pulled from chat.users.email — pi-harness's gccli shim keys
    // accounts.json on this value (replaces the HARNESS_USER_EMAIL workaround).
    expect(body.email).toBe('user@example.com')
    // Defensive: plaintext refresh token must never appear in the response.
    expect(text).not.toContain('refresh-token-plaintext')

    // Two queries: SELECT refresh_token, then UPDATE last_refreshed_at + scopes.
    const updateCall = calls.find((c) => /^\s*UPDATE pi\.oauth_tokens/i.test(c.sql))
    expect(updateCall).toBeDefined()
    expect(updateCall!.sql).toContain('last_refreshed_at = NOW()')
    expect(updateCall!.sql).toContain('scopes = $3')
    expect(updateCall!.params[0]).toBe(VALID_USER_ID)
    expect(updateCall!.params[1]).toBe('google')
    expect(updateCall!.params[2]).toEqual([
      'https://www.googleapis.com/auth/drive.readonly',
      'openid',
      'email',
    ])
  })

  test('200 omits email when chat.users row is missing (pathological state)', async () => {
    // pi.oauth_tokens row exists but matching chat.users row does not.
    // Real cause would be a ON DELETE CASCADE race or DB corruption — the
    // mint should still succeed, just without an email field.
    const { encryptToken } = await import('../lib/crypto')
    const ct = encryptToken('rt')

    const calls: Array<{ sql: string; params: unknown[] }> = []
    mockPool.query.mockImplementation(buildAccessTokenQueryMock(ct, calls, null))

    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          access_token: 'ya29.fresh',
          expires_in: 3599,
          scope: 'openid email',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    // Capture warn output to assert the warning fires.
    const originalWarn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }

    try {
      const app = makeApp()
      const res = await app.request('/api/oauth/google/access-token', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TEST_SERVICE_TOKEN}`,
        },
        body: JSON.stringify({ userId: VALID_USER_ID }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        access_token: string
        expires_in: number
        email?: string
      }
      expect(body.access_token).toBe('ya29.fresh')
      expect(body.expires_in).toBe(3599)
      expect(body.email).toBeUndefined()

      const matched = warnings.some((args) =>
        args.some(
          (a) =>
            typeof a === 'string' && a.includes('no chat.users.email for user'),
        ),
      )
      expect(matched).toBe(true)
    } finally {
      console.warn = originalWarn
    }
  })

  test('200 with new scope set when Google returns different scopes', async () => {
    const { encryptToken } = await import('../lib/crypto')
    const ct = encryptToken('rt')

    const calls: Array<{ sql: string; params: unknown[] }> = []
    mockPool.query.mockImplementation(buildAccessTokenQueryMock(ct, calls))

    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          access_token: 'ya29.x',
          expires_in: 3599,
          // user revoked gmail scope between grants, say
          scope: 'https://www.googleapis.com/auth/drive.readonly openid',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const app = makeApp()
    const res = await app.request('/api/oauth/google/access-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_SERVICE_TOKEN}`,
      },
      body: JSON.stringify({ userId: VALID_USER_ID }),
    })
    expect(res.status).toBe(200)

    const updateCall = calls.find((c) => /^\s*UPDATE pi\.oauth_tokens/i.test(c.sql))
    expect(updateCall!.params[2]).toEqual([
      'https://www.googleapis.com/auth/drive.readonly',
      'openid',
    ])
  })

  test('401 + row deletion when Google says the grant is revoked (400 invalid_grant)', async () => {
    const { encryptToken } = await import('../lib/crypto')
    const ct = encryptToken('rt')

    const calls: Array<{ sql: string; params: unknown[] }> = []
    mockPool.query.mockImplementation(buildAccessTokenQueryMock(ct, calls))

    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const app = makeApp()
    const res = await app.request('/api/oauth/google/access-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_SERVICE_TOKEN}`,
      },
      body: JSON.stringify({ userId: VALID_USER_ID }),
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('oauth_revoked')

    const deleteCall = calls.find((c) => /^\s*DELETE FROM pi\.oauth_tokens/i.test(c.sql))
    expect(deleteCall).toBeDefined()
    expect(deleteCall!.params[0]).toBe(VALID_USER_ID)
    expect(deleteCall!.params[1]).toBe('google')
  })

  test('401 + row deletion when Google returns 401', async () => {
    const { encryptToken } = await import('../lib/crypto')
    const ct = encryptToken('rt')

    const calls: Array<{ sql: string; params: unknown[] }> = []
    mockPool.query.mockImplementation(buildAccessTokenQueryMock(ct, calls))

    globalThis.fetch = mock(async () => new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch

    const app = makeApp()
    const res = await app.request('/api/oauth/google/access-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_SERVICE_TOKEN}`,
      },
      body: JSON.stringify({ userId: VALID_USER_ID }),
    })
    expect(res.status).toBe(401)
    const deleteCall = calls.find((c) => /^\s*DELETE FROM pi\.oauth_tokens/i.test(c.sql))
    expect(deleteCall).toBeDefined()
  })

  test('502 on transient Google failure (5xx) — row NOT deleted', async () => {
    const { encryptToken } = await import('../lib/crypto')
    const ct = encryptToken('rt')

    const calls: Array<{ sql: string; params: unknown[] }> = []
    mockPool.query.mockImplementation(buildAccessTokenQueryMock(ct, calls))

    globalThis.fetch = mock(async () => new Response('upstream blew up', { status: 503 })) as unknown as typeof fetch

    const app = makeApp()
    const res = await app.request('/api/oauth/google/access-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_SERVICE_TOKEN}`,
      },
      body: JSON.stringify({ userId: VALID_USER_ID }),
    })
    expect(res.status).toBe(502)
    const deleteCall = calls.find((c) => /^\s*DELETE FROM pi\.oauth_tokens/i.test(c.sql))
    expect(deleteCall).toBeUndefined()
  })
})
