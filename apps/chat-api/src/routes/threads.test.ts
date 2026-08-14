// DB-21 — keyset pagination on GET /threads/:id. The old handler loaded the
// entire message history in one unbounded scan; these tests pin the bounded
// behaviour: at most one page (newest-first internally, returned ascending),
// over-fetch-by-one to report hasMore, and a `before` cursor for older pages.
import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'

interface QueryResult {
  rows: Record<string, unknown>[]
  rowCount: number
}

// Captures every query the route issues so we can assert the SQL shape + params.
let poolCalls: Array<{ sql: string; params: unknown[] }> = []
let mockPoolQueryImpl: (sql: string, params?: unknown[]) => Promise<QueryResult> = async () => ({
  rows: [],
  rowCount: 0,
})

const mockPool = {
  query: mock(async (sql: string, params?: unknown[]) => {
    poolCalls.push({ sql, params: params ?? [] })
    return mockPoolQueryImpl(sql, params)
  }),
  // connect is unused by threads.ts (query-only) but kept so the process-global
  // mock.module doesn't break a sibling that calls it.
  connect: mock(async () => ({ query: mockPool.query, release: () => {} })),
}

// mock.module is process-global in bun, so this replaces ../lib/db for every
// chat-api test file. Mirror the real test-env surface: `hasDatabase` is
// exported (siblings import it transitively) and false (no DATABASE_URL in
// tests), so leaked siblings keep their isolation behaviour.
mock.module('../lib/db', () => ({ getPool: () => mockPool, hasDatabase: false }))
mock.module('../middleware/session', () => ({
  requireSession: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set('user', { id: 'user-1' })
    await next()
  },
}))

const { threadRoutes } = await import('./threads')

const THREAD_ID = 'thread-1'

function makeApp() {
  const app = new Hono()
  app.route('/threads', threadRoutes)
  return app
}

// Build N message rows with increasing timestamps. The route queries DESC, so
// the mock returns them newest-first to mirror Postgres.
function messageRows(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m-${n - i}`,
    role: i % 2 === 0 ? 'assistant' : 'user',
    content: { text: `msg ${n - i}` },
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, n - i)),
  }))
}

beforeEach(() => {
  poolCalls = []
  mockPoolQueryImpl = async () => ({ rows: [], rowCount: 0 })
})

describe('GET /threads/:id (DB-21 pagination)', () => {
  test('short thread → all messages ascending, hasMore false, nextBefore null', async () => {
    mockPoolQueryImpl = async (sql: string) => {
      if (/FROM chat\.threads/i.test(sql)) {
        return { rows: [{ id: THREAD_ID, title: 't', provider: null, model: null }], rowCount: 1 }
      }
      if (/FROM chat\.messages/i.test(sql)) return { rows: messageRows(3), rowCount: 3 }
      return { rows: [], rowCount: 0 }
    }

    const res = await makeApp().request(`/threads/${THREAD_ID}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      messages: { id: string; created_at: string }[]
      hasMore: boolean
      nextBefore: string | null
    }
    expect(body.messages).toHaveLength(3)
    // Returned ascending (oldest first) for display.
    expect(body.messages[0]!.id).toBe('m-1')
    expect(body.messages[2]!.id).toBe('m-3')
    expect(body.hasMore).toBe(false)
    expect(body.nextBefore).toBeNull()
  })

  test('bounded query: LIMIT 201, ordered DESC, no cursor clause by default', async () => {
    mockPoolQueryImpl = async (sql: string) => {
      if (/FROM chat\.threads/i.test(sql)) {
        return { rows: [{ id: THREAD_ID }], rowCount: 1 }
      }
      return { rows: messageRows(1), rowCount: 1 }
    }
    await makeApp().request(`/threads/${THREAD_ID}`)
    const msgQuery = poolCalls.find((c) => /FROM chat\.messages/i.test(c.sql))!
    expect(msgQuery.sql).toMatch(/LIMIT 201/)
    expect(msgQuery.sql).toMatch(/ORDER BY created_at DESC, id DESC/)
    expect(msgQuery.sql).not.toMatch(/created_at, id\) </) // no cursor without ?before
    expect(msgQuery.params).toEqual([THREAD_ID, 'user-1'])
  })

  test('full page → hasMore true and nextBefore points at the oldest returned', async () => {
    // 201 rows back (LIMIT+1) means a 202nd older row exists.
    mockPoolQueryImpl = async (sql: string) => {
      if (/FROM chat\.threads/i.test(sql)) return { rows: [{ id: THREAD_ID }], rowCount: 1 }
      return { rows: messageRows(201), rowCount: 201 }
    }
    const res = await makeApp().request(`/threads/${THREAD_ID}`)
    const body = (await res.json()) as {
      messages: { id: string }[]
      hasMore: boolean
      nextBefore: string | null
    }
    expect(body.messages).toHaveLength(200) // the +1 is trimmed
    expect(body.hasMore).toBe(true)
    // The 201st row (m-1) is the trimmed over-fetch; the oldest DISPLAYED row
    // is m-2, so the cursor for the next-older page points at it.
    expect(body.nextBefore).toMatch(/,m-2$/)
    expect(body.messages[0]!.id).toBe('m-2')
  })

  test('?before=ts,id → adds the keyset cursor clause + params', async () => {
    mockPoolQueryImpl = async (sql: string) => {
      if (/FROM chat\.threads/i.test(sql)) return { rows: [{ id: THREAD_ID }], rowCount: 1 }
      return { rows: messageRows(2), rowCount: 2 }
    }
    const cursor = '2026-01-01T00:00:05.000Z,m-5'
    await makeApp().request(`/threads/${THREAD_ID}?before=${encodeURIComponent(cursor)}`)
    const msgQuery = poolCalls.find((c) => /FROM chat\.messages/i.test(c.sql))!
    expect(msgQuery.sql).toMatch(/\(created_at, id\) < \(\$3::timestamptz, \$4::text\)/)
    expect(msgQuery.params).toEqual([THREAD_ID, 'user-1', '2026-01-01T00:00:05.000Z', 'm-5'])
  })

  test('unknown thread → 404', async () => {
    mockPoolQueryImpl = async () => ({ rows: [], rowCount: 0 })
    const res = await makeApp().request(`/threads/${THREAD_ID}`)
    expect(res.status).toBe(404)
  })
})
