/**
 * Tests for the /api/rag/* browser-facing proxy. Five concerns:
 *   1. /enabled reflects RAG config without auth
 *   2. Routes 503 when RAG is unconfigured
 *   3. Sync injects user_id from the session and forwards
 *   4. Status uses the session user's id in the path
 *   5. The bearer never appears in the response and headers go to rag-api
 *
 * Run with: bun test apps/controller/src/routes/rag.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'

const TEST_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

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
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set('user', {
      id: TEST_USER_ID,
      email: 'test@example.com',
      name: 'Test',
      picture: null,
      sub: 'test-sub',
      releaseChannel: 'alpha' as const,
    })
    await next()
  },
}))

const { ragRoutes } = await import('./rag')
const { _resetWarnLatchForTests } = await import('../lib/rag-config')

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_API_URL = process.env.RAG_API_URL
const ORIGINAL_TOKEN = process.env.RAG_SERVICE_TOKEN

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

function stubFetch(response: Response): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: typeof url === 'string' ? url : url.toString(), init })
    return response
  }) as typeof globalThis.fetch
  return calls
}

beforeEach(() => {
  delete process.env.RAG_API_URL
  delete process.env.RAG_SERVICE_TOKEN
  _resetWarnLatchForTests()
  mockPool.query.mockReset()
  mockPool.query.mockImplementation(async () => ({ rows: [], rowCount: 0 }))
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  if (ORIGINAL_API_URL === undefined) delete process.env.RAG_API_URL
  else process.env.RAG_API_URL = ORIGINAL_API_URL
  if (ORIGINAL_TOKEN === undefined) delete process.env.RAG_SERVICE_TOKEN
  else process.env.RAG_SERVICE_TOKEN = ORIGINAL_TOKEN
})

function makeApp() {
  const app = new Hono()
  app.route('/api/rag', ragRoutes)
  return app
}

describe('GET /api/rag/enabled', () => {
  it('returns enabled=false when RAG is unconfigured', async () => {
    const app = makeApp()
    const res = await app.request('/api/rag/enabled')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: false })
  })

  it('returns enabled=true when both env vars are set', async () => {
    process.env.RAG_API_URL = 'https://rag.example.com'
    process.env.RAG_SERVICE_TOKEN = 'tok-123'
    const app = makeApp()
    const res = await app.request('/api/rag/enabled')
    expect(await res.json()).toEqual({ enabled: true })
  })
})

describe('503 behaviour when RAG is unconfigured', () => {
  it('POST /sync returns 503', async () => {
    const app = makeApp()
    const res = await app.request('/api/rag/sync', { method: 'POST', body: '{}' })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('rag') })
  })

  it('GET /status returns 503', async () => {
    const app = makeApp()
    const res = await app.request('/api/rag/status')
    expect(res.status).toBe(503)
  })

  it('POST /forget returns 503', async () => {
    const app = makeApp()
    const res = await app.request('/api/rag/forget', { method: 'POST' })
    expect(res.status).toBe(503)
  })
})

describe('proxy behaviour when RAG is configured', () => {
  beforeEach(() => {
    process.env.RAG_API_URL = 'https://rag.example.com'
    process.env.RAG_SERVICE_TOKEN = 'tok-secret'
  })

  it('POST /sync injects user_id from session and forwards to rag-api', async () => {
    const calls = stubFetch(
      new Response(JSON.stringify({ job_id: 'j-1', status: 'queued' }), { status: 200 }),
    )
    const app = makeApp()
    const res = await app.request('/api/rag/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ job_id: 'j-1', status: 'queued' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://rag.example.com/api/v1/users/sync')
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-secret')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      user_id: TEST_USER_ID,
      force: true,
    })
  })

  it('POST /sync defaults force to false when omitted', async () => {
    const calls = stubFetch(new Response('{}', { status: 200 }))
    const app = makeApp()
    await app.request('/api/rag/sync', { method: 'POST', body: '{}' })
    const body = JSON.parse(calls[0]!.init!.body as string) as { force: boolean }
    expect(body.force).toBe(false)
  })

  it('GET /status uses the session user id in the path', async () => {
    const calls = stubFetch(
      new Response(JSON.stringify({ last_synced_at: null, file_count: 0 }), { status: 200 }),
    )
    const app = makeApp()
    const res = await app.request('/api/rag/status')
    expect(res.status).toBe(200)
    expect(calls[0]!.url).toBe(`https://rag.example.com/api/v1/users/${TEST_USER_ID}/status`)
    // Bearer goes to rag-api but never reaches the browser response.
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-secret')
    const responseBody = await res.text()
    expect(responseBody).not.toContain('tok-secret')
    expect(responseBody).not.toContain('Bearer')
  })

  it('GET /status forwards rag-api 404 status (unknown user)', async () => {
    stubFetch(
      new Response(JSON.stringify({ error: 'user not found' }), { status: 404 }),
    )
    const app = makeApp()
    const res = await app.request('/api/rag/status')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'user not found' })
  })

  it('POST /forget uses the session user id in the path', async () => {
    const calls = stubFetch(
      new Response(JSON.stringify({ ok: true, removed_files: 0 }), { status: 200 }),
    )
    const app = makeApp()
    await app.request('/api/rag/forget', { method: 'POST' })
    expect(calls[0]!.url).toBe(`https://rag.example.com/api/v1/users/${TEST_USER_ID}/forget`)
    expect(calls[0]!.init?.method).toBe('POST')
  })

  it('strips trailing slash from RAG_API_URL', async () => {
    process.env.RAG_API_URL = 'https://rag.example.com/'
    const calls = stubFetch(new Response('{}', { status: 200 }))
    const app = makeApp()
    await app.request('/api/rag/status')
    expect(calls[0]!.url).toBe(`https://rag.example.com/api/v1/users/${TEST_USER_ID}/status`)
  })
})
