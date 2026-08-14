import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// M4 — reaper / finishJob durability (BUG-08, BUG-09). We mock ./db's getPool
// so the function control-flow (race guard, oauth-revoke status, retention)
// is exercised without a real Postgres. The SQL WHERE semantics are Postgres'
// job; these tests pin the JS-side behaviour that was previously untested.

interface QueryResult {
  rows: Record<string, unknown>[]
  rowCount: number
}

const calls: { sql: string; params: unknown[] }[] = []
// Per-SQL-shape canned responses, settable per test.
let finishUpdateRows: Record<string, unknown>[] = [{ id: 'job-1' }]
let reapRows: Record<string, unknown>[] = []

const mockPool = {
  query: mock(async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
    calls.push({ sql, params })
    if (/UPDATE rag\.sync_jobs[\s\S]*status = \$2[\s\S]*RETURNING id/.test(sql)) {
      return { rows: finishUpdateRows, rowCount: finishUpdateRows.length }
    }
    if (/UPDATE rag\.sync_jobs[\s\S]*status = 'failed'[\s\S]*RETURNING id, user_id/.test(sql)) {
      return { rows: reapRows, rowCount: reapRows.length }
    }
    if (/DELETE FROM rag\.sync_jobs/.test(sql)) {
      return { rows: [], rowCount: 3 }
    }
    return { rows: [], rowCount: 1 }
  }),
}

mock.module('./db', () => ({ getPool: () => mockPool }))

const { finishJob, reapStuckJobs, pruneOldJobs } = await import('./index')

const userUpdates = () => calls.filter((c) => /UPDATE rag\.users/.test(c.sql))

beforeEach(() => {
  calls.length = 0
  mockPool.query.mockClear()
  finishUpdateRows = [{ id: 'job-1' }]
  reapRows = []
})
afterEach(() => {
  finishUpdateRows = [{ id: 'job-1' }]
  reapRows = []
})

describe('finishJob (BUG-09 race guard + BUG-08 oauth status)', () => {
  test('lost the race (0 rows from status-guard UPDATE) → skips the rag.users write', async () => {
    finishUpdateRows = []
    await finishJob('job-1', 'user-1', true, { files_seen: 5 })
    expect(userUpdates().length).toBe(0)
  })

  test('success → writes drive_oauth_status = ok', async () => {
    await finishJob('job-1', 'user-1', true, { files_seen: 5 })
    const u = userUpdates()
    expect(u.length).toBe(1)
    expect(u[0]!.sql).toContain("drive_oauth_status = 'ok'")
  })

  test('failure + oauthRevoked → marks the user failed (stops the 15-min recrawl loop)', async () => {
    await finishJob('job-1', 'user-1', false, { error: 'controller mint 401', oauthRevoked: true })
    const u = userUpdates()
    expect(u.length).toBe(1)
    expect(u[0]!.sql).toContain("drive_oauth_status = 'failed'")
  })

  test('transient failure (not oauthRevoked) → does NOT mark the user failed', async () => {
    await finishJob('job-1', 'user-1', false, { error: 'ragflow 503', oauthRevoked: false })
    const u = userUpdates()
    expect(u.length).toBe(1)
    expect(u[0]!.sql).not.toContain("drive_oauth_status = 'failed'")
  })
})

describe('reapStuckJobs (BUG-09)', () => {
  test('records last_error on each reaped user', async () => {
    reapRows = [
      { id: 'job-a', user_id: 'user-a' },
      { id: 'job-b', user_id: 'user-b' },
    ]
    await reapStuckJobs()
    const u = userUpdates()
    expect(u.length).toBe(2)
    expect(u.map((c) => c.params[0])).toEqual(['user-a', 'user-b'])
  })

  test('reaps on heartbeat-or-start staleness (COALESCE in the predicate)', async () => {
    reapRows = []
    await reapStuckJobs()
    const reapCall = calls.find((c) => /status = 'failed'[\s\S]*RETURNING id, user_id/.test(c.sql))
    expect(reapCall).toBeDefined()
    expect(reapCall!.sql).toContain('COALESCE(heartbeat_at, started_at)')
  })
})

describe('pruneOldJobs (BUG-08 retention)', () => {
  test('deletes terminal jobs past the retention window', async () => {
    await pruneOldJobs()
    const del = calls.find((c) => /DELETE FROM rag\.sync_jobs/.test(c.sql))
    expect(del).toBeDefined()
    expect(del!.sql).toMatch(/status IN \('completed', 'failed'\)/)
    expect(del!.params).toEqual([30])
  })
})
