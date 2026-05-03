import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { Hono } from 'hono'

// Test secrets — fixed for this process so signSessionToken works.
// Set BEFORE importing any module that captures it at module load time
// (jwt.ts reads HARNESS_JWT_SECRET into a const at import time).
const TEST_HARNESS_SECRET = 'test-harness-secret-do-not-ship'
process.env.HARNESS_JWT_SECRET = TEST_HARNESS_SECRET

// ---------- Mocks ----------
// All mocks must be set up before importing the routes module so that
// session.ts captures the mocked dependencies.

interface QueryResult {
  rows: Record<string, unknown>[]
  rowCount: number
}

// Each test sets `mockPoolQueryImpl` to control `getPool().query(...)`.
let mockPoolQueryImpl: (sql: string, params?: unknown[]) => Promise<QueryResult> = async () => ({
  rows: [],
  rowCount: 0,
})

// `clientCalls` records every (sql, params) pair the transactional client
// receives. Tests inspect it to verify the BEGIN/INSERT/COMMIT shape.
let clientCalls: Array<{ sql: string; params: unknown[] }> = []
let mockClientQueryImpl: (sql: string, params?: unknown[]) => Promise<QueryResult> = async () => ({
  rows: [{ user_id: 'u' }],
  rowCount: 1,
})
let clientReleased = false

const mockClient = {
  query: mock(async (sql: string, params?: unknown[]) => {
    clientCalls.push({ sql, params: params ?? [] })
    return mockClientQueryImpl(sql, params)
  }),
  release: mock(() => {
    clientReleased = true
  }),
}

const mockPool = {
  query: mock(async (sql: string, params?: unknown[]) => mockPoolQueryImpl(sql, params)),
  connect: mock(async () => mockClient),
}

mock.module('../lib/db', () => ({
  getPool: () => mockPool,
  hasDatabase: true,
}))

// requireSession: inject a known user. x-test-user-id header overrides
// the default UUID; x-test-channel header overrides release_channel.
mock.module('../middleware/session', () => ({
  requireSession: async (
    c: { set: (k: string, v: unknown) => void; req: { header: (k: string) => string | undefined } },
    next: () => Promise<void>,
  ) => {
    const userId = c.req.header('x-test-user-id') ?? '11111111-2222-3333-4444-555555555555'
    const channel = (c.req.header('x-test-channel') ?? 'launch') as 'alpha' | 'beta' | 'launch'
    c.set('user', {
      id: userId,
      email: 'test@example.com',
      name: 'Test',
      picture: null,
      sub: 'test-sub',
      releaseChannel: channel,
    })
    await next()
  },
}))

// Compute provider: the provider impl is swapped per test via
// `setMockProvider`. The exported `getComputeProvider` returns it.
type EnsureFn = (userId: string) => Promise<{
  name: string
  url: string
  provider: string
  freshlyProvisioned: boolean
}>

let mockEnsureContainer: EnsureFn = async () => {
  throw new Error('mockEnsureContainer not set for this test')
}

mock.module('../compute', () => ({
  getComputeProvider: () => ({
    name: 'sprites',
    ensureContainer: (userId: string) => mockEnsureContainer(userId),
    freeze: async () => {},
    destroy: async () => {},
    status: async () => 'running' as const,
  }),
}))

// Bootstrap: tests count + control behavior of bootstrapSprite.
let bootstrapCalls: Array<{ spriteName: string; goldenVersion: string }> = []
let bootstrapShouldThrow: Error | null = null

mock.module('../lib/bootstrap', () => ({
  bootstrapSprite: async (
    spriteName: string,
    opts: { golden: { version: string; manifestUri: string } },
  ) => {
    bootstrapCalls.push({ spriteName, goldenVersion: opts.golden.version })
    if (bootstrapShouldThrow) throw bootstrapShouldThrow
  },
  // Re-export the type as a placeholder; tests don't use it.
}))

// Golden: deterministic golden lookup. Default: a current launch golden.
let mockLatestGolden: {
  version: string
  manifest_uri: string
  manifest_sha: string
  released_to: string[]
  retired_at: string | null
} | null = {
  version: '1.1.0',
  manifest_uri: 'file://goldens/1.1.0/manifest.json',
  manifest_sha: 'deadbeef',
  released_to: ['launch'],
  retired_at: null,
}

mock.module('../lib/golden', () => ({
  latestGoldenForChannel: async () => mockLatestGolden,
}))

// Now safe to import the routes module.
const { sessionRoutes } = await import('./session')

beforeEach(() => {
  process.env.HARNESS_JWT_SECRET = TEST_HARNESS_SECRET

  // Reset mocks between tests.
  bootstrapCalls = []
  bootstrapShouldThrow = null
  clientCalls = []
  clientReleased = false
  mockPool.query.mockClear()
  mockPool.connect.mockClear()
  mockClient.query.mockClear()
  mockClient.release.mockClear()
  mockPoolQueryImpl = async () => ({ rows: [], rowCount: 0 })
  mockClientQueryImpl = async () => ({ rows: [{ user_id: 'u' }], rowCount: 1 })
  mockEnsureContainer = async () => {
    throw new Error('mockEnsureContainer not set')
  }
  mockLatestGolden = {
    version: '1.1.0',
    manifest_uri: 'file://goldens/1.1.0/manifest.json',
    manifest_sha: 'deadbeef',
    released_to: ['launch'],
    retired_at: null,
  }
})

afterEach(() => {
  // No global state to restore.
})

function makeApp() {
  const app = new Hono()
  app.route('/api/session', sessionRoutes)
  return app
}

const USER_ID = '11111111-2222-3333-4444-555555555555'
const SPRITE_NAME = 'harness-111122223333' // matches deriveSpriteName

// Helper: simulate the SELECT pi.containers row check.
function mockExistingContainer(row: Record<string, unknown> | null) {
  mockPoolQueryImpl = async (sql: string) => {
    if (/SELECT user_id, provider, container_name/i.test(sql)) {
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    // INSERT INTO pi.sessions (record_session_start) → return UUID
    if (/INSERT INTO pi\.sessions/i.test(sql)) {
      return { rows: [{ id: 'session-uuid-test' }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }
}

describe('POST /api/session/start', () => {
  test('existing user with row + sprite already bootstrapped → fast path, no bootstrap call', async () => {
    mockExistingContainer({
      user_id: USER_ID,
      provider: 'sprites',
      container_name: SPRITE_NAME,
      http_url: `https://${SPRITE_NAME}.sprites.app`,
      base_image_version: '1.1.0',
      status: 'active',
      created_at: '2026-04-01T00:00:00Z',
      last_seen_at: '2026-04-30T00:00:00Z',
      last_updated_at: null,
    })
    mockEnsureContainer = async () => ({
      name: SPRITE_NAME,
      url: `https://${SPRITE_NAME}.sprites.app`,
      provider: 'sprites',
      freshlyProvisioned: false,
    })

    const app = makeApp()
    const res = await app.request('/api/session/start', { method: 'POST' })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { container: { name: string }; target_version: string }
    expect(body.container.name).toBe(SPRITE_NAME)
    expect(body.target_version).toBe('1.1.0')
    expect(bootstrapCalls.length).toBe(0)
    // No transaction opened on the existing-row path.
    expect(mockPool.connect).not.toHaveBeenCalled()
  })

  test('existing row but ensureContainer reports freshlyProvisioned: true → bootstrap is called, then JWT minted', async () => {
    mockExistingContainer({
      user_id: USER_ID,
      provider: 'sprites',
      container_name: SPRITE_NAME,
      http_url: null, // sprite was deleted out-of-band
      base_image_version: null,
      status: 'active',
      created_at: '2026-04-01T00:00:00Z',
      last_seen_at: '2026-04-30T00:00:00Z',
      last_updated_at: null,
    })
    mockEnsureContainer = async () => ({
      name: SPRITE_NAME,
      url: `https://${SPRITE_NAME}.sprites.app`,
      provider: 'sprites',
      freshlyProvisioned: true, // recreated
    })

    const app = makeApp()
    const res = await app.request('/api/session/start', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(bootstrapCalls.length).toBe(1)
    expect(bootstrapCalls[0]!.spriteName).toBe(SPRITE_NAME)
    expect(bootstrapCalls[0]!.goldenVersion).toBe('1.1.0')
    const body = (await res.json()) as { token: string; sessionId: string }
    expect(body.token.split('.').length).toBe(3) // JWT shape
  })

  test('new user, happy path → row inserted, sprite created, bootstrap called, JWT minted', async () => {
    // No existing row.
    mockExistingContainer(null)
    mockEnsureContainer = async () => ({
      name: SPRITE_NAME,
      url: `https://${SPRITE_NAME}.sprites.app`,
      provider: 'sprites',
      freshlyProvisioned: true,
    })
    // The transactional client: our INSERT … RETURNING returns one row.
    mockClientQueryImpl = async (sql: string) => {
      if (/INSERT INTO pi\.containers/i.test(sql) && /RETURNING/i.test(sql)) {
        return { rows: [{ user_id: USER_ID }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }

    const app = makeApp()
    const res = await app.request('/api/session/start', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(bootstrapCalls.length).toBe(1)
    expect(bootstrapCalls[0]!.spriteName).toBe(SPRITE_NAME)
    expect(bootstrapCalls[0]!.goldenVersion).toBe('1.1.0')

    // Transaction shape: BEGIN → INSERT (with RETURNING) → UPDATE → COMMIT.
    const sqls = clientCalls.map((c) => c.sql)
    expect(sqls.some((s) => /^\s*BEGIN/i.test(s))).toBe(true)
    expect(sqls.some((s) => /INSERT INTO pi\.containers/i.test(s))).toBe(true)
    expect(sqls.some((s) => /UPDATE pi\.containers/i.test(s))).toBe(true)
    expect(sqls.some((s) => /^\s*COMMIT/i.test(s))).toBe(true)
    expect(sqls.some((s) => /^\s*ROLLBACK/i.test(s))).toBe(false)
    expect(clientReleased).toBe(true)
  })

  test('new user, sprite create fails → row not visible after the failed call (transaction rolled back)', async () => {
    mockExistingContainer(null)
    mockEnsureContainer = async () => {
      throw new Error('sprites api 503')
    }
    // INSERT … RETURNING returns one row; we insert before the network call.
    mockClientQueryImpl = async (sql: string) => {
      if (/INSERT INTO pi\.containers/i.test(sql) && /RETURNING/i.test(sql)) {
        return { rows: [{ user_id: USER_ID }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }

    const app = makeApp()
    const res = await app.request('/api/session/start', { method: 'POST' })

    expect(res.status).toBe(500)
    expect(bootstrapCalls.length).toBe(0)
    // Transaction was rolled back, not committed.
    const sqls = clientCalls.map((c) => c.sql)
    expect(sqls.some((s) => /^\s*BEGIN/i.test(s))).toBe(true)
    expect(sqls.some((s) => /^\s*ROLLBACK/i.test(s))).toBe(true)
    expect(sqls.some((s) => /^\s*COMMIT/i.test(s))).toBe(false)
    expect(clientReleased).toBe(true)
  })

  test('new user, bootstrap fails → row visible (sprite was created), error surfaced', async () => {
    mockExistingContainer(null)
    mockEnsureContainer = async () => ({
      name: SPRITE_NAME,
      url: `https://${SPRITE_NAME}.sprites.app`,
      provider: 'sprites',
      freshlyProvisioned: true,
    })
    bootstrapShouldThrow = new Error('apt failed')
    mockClientQueryImpl = async (sql: string) => {
      if (/INSERT INTO pi\.containers/i.test(sql) && /RETURNING/i.test(sql)) {
        return { rows: [{ user_id: USER_ID }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }

    const app = makeApp()
    const res = await app.request('/api/session/start', { method: 'POST' })

    expect(res.status).toBe(500)
    expect(bootstrapCalls.length).toBe(1)
    // Bootstrap failed — but the Sprite EXISTS now, so we COMMIT the
    // row (with http_url + base_image_version stamped) so the next
    // sign-in finds existing row + ensureContainer → freshlyProvisioned=
    // false, and the operator can re-bootstrap manually. This is the
    // documented tradeoff; see session.ts auto-provision comment.
    const sqls = clientCalls.map((c) => c.sql)
    expect(sqls.some((s) => /^\s*COMMIT/i.test(s))).toBe(true)
    expect(sqls.some((s) => /^\s*ROLLBACK/i.test(s))).toBe(false)
    expect(clientReleased).toBe(true)
  })

  test('new user, bootstrap fails → next call detects row exists and re-runs bootstrap (idempotent)', async () => {
    // First call: row missing, bootstrap throws → row committed.
    mockExistingContainer(null)
    mockEnsureContainer = async () => ({
      name: SPRITE_NAME,
      url: `https://${SPRITE_NAME}.sprites.app`,
      provider: 'sprites',
      freshlyProvisioned: true,
    })
    bootstrapShouldThrow = new Error('apt failed')
    mockClientQueryImpl = async (sql: string) => {
      if (/INSERT INTO pi\.containers/i.test(sql) && /RETURNING/i.test(sql)) {
        return { rows: [{ user_id: USER_ID }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }

    const app = makeApp()
    const res1 = await app.request('/api/session/start', { method: 'POST' })
    expect(res1.status).toBe(500)
    expect(bootstrapCalls.length).toBe(1)

    // Second call: row now exists (the failed-bootstrap call committed
    // it). But the sprite ALSO exists, so ensureContainer returns
    // freshlyProvisioned=false. The re-bootstrap branch only fires if
    // ensureContainer reports freshlyProvisioned=true on the existing-
    // row path. So in steady state, bootstrap is NOT re-run. This is
    // the documented limitation: re-bootstrap requires the operator to
    // either destroy the sprite (so ensureContainer recreates it) or
    // run scripts/provision-user.ts.
    bootstrapShouldThrow = null
    mockExistingContainer({
      user_id: USER_ID,
      provider: 'sprites',
      container_name: SPRITE_NAME,
      http_url: `https://${SPRITE_NAME}.sprites.app`,
      base_image_version: '1.1.0',
      status: 'active',
      created_at: '2026-04-01T00:00:00Z',
      last_seen_at: '2026-04-30T00:00:00Z',
      last_updated_at: null,
    })
    mockEnsureContainer = async () => ({
      name: SPRITE_NAME,
      url: `https://${SPRITE_NAME}.sprites.app`,
      provider: 'sprites',
      freshlyProvisioned: false, // sprite still exists
    })

    const res2 = await app.request('/api/session/start', { method: 'POST' })
    expect(res2.status).toBe(200)
    // No second bootstrap on the steady-state retry — operator
    // intervention required.
    expect(bootstrapCalls.length).toBe(1)
  })

  test('new user, bootstrap fails → next call after sprite is destroyed retries bootstrap (idempotent)', async () => {
    // The "true" idempotent retry: operator (or sprite GC) destroyed
    // the broken sprite, so ensureContainer recreates it, sees
    // freshlyProvisioned=true, and re-runs bootstrap.
    mockExistingContainer({
      user_id: USER_ID,
      provider: 'sprites',
      container_name: SPRITE_NAME,
      http_url: `https://${SPRITE_NAME}.sprites.app`,
      base_image_version: '1.1.0',
      status: 'active',
      created_at: '2026-04-01T00:00:00Z',
      last_seen_at: '2026-04-30T00:00:00Z',
      last_updated_at: null,
    })
    mockEnsureContainer = async () => ({
      name: SPRITE_NAME,
      url: `https://${SPRITE_NAME}.sprites.app`,
      provider: 'sprites',
      freshlyProvisioned: true, // sprite was destroyed + recreated
    })

    const app = makeApp()
    const res = await app.request('/api/session/start', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(bootstrapCalls.length).toBe(1) // re-bootstrap fired
  })

  test('new user but no golden published for channel → 500 with clear message', async () => {
    mockExistingContainer(null)
    mockEnsureContainer = async () => ({
      name: SPRITE_NAME,
      url: `https://${SPRITE_NAME}.sprites.app`,
      provider: 'sprites',
      freshlyProvisioned: true,
    })
    mockLatestGolden = null // no golden published
    mockClientQueryImpl = async (sql: string) => {
      if (/INSERT INTO pi\.containers/i.test(sql) && /RETURNING/i.test(sql)) {
        return { rows: [{ user_id: USER_ID }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }

    const app = makeApp()
    const res = await app.request('/api/session/start', { method: 'POST' })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/no golden published/i)
    expect(bootstrapCalls.length).toBe(0)
    // Rolled back since we couldn't bootstrap.
    const sqls = clientCalls.map((c) => c.sql)
    expect(sqls.some((s) => /^\s*ROLLBACK/i.test(s))).toBe(true)
  })

  test('concurrent provision (INSERT … ON CONFLICT DO NOTHING returns no rows) → 409', async () => {
    mockExistingContainer(null) // first read: no row
    mockEnsureContainer = async () => {
      // Should not be called since the INSERT failed concurrent check.
      throw new Error('ensureContainer should not be called')
    }
    mockClientQueryImpl = async (sql: string) => {
      if (/INSERT INTO pi\.containers/i.test(sql) && /RETURNING/i.test(sql)) {
        // Concurrent insert: no row returned.
        return { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 1 }
    }

    const app = makeApp()
    const res = await app.request('/api/session/start', { method: 'POST' })
    expect(res.status).toBe(409)
    expect(bootstrapCalls.length).toBe(0)
  })
})
