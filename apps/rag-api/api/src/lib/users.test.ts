/**
 * Verifies the read/write split between findUser (lookup-only) and
 * resolveUser (upsert). The whole point of the split is that any
 * inbound user_id from a stale or buggy caller should NOT silently
 * create a rag.users row; only POST /users/sync — the legitimate
 * first-touch boundary — should auto-create.
 *
 * Run with: bun test apps/rag-api/api/src/lib/users.test.ts
 */
import { describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'
import { findUser, resolveUser } from './users'

interface FakeQuery {
  sql: string
  params: readonly unknown[]
}

function makeFakePool(rowsToReturn: Array<{ id: string }>): Pool & { history: FakeQuery[] } {
  const history: FakeQuery[] = []
  const pool = {
    history,
    query(sql: string, params: readonly unknown[]) {
      history.push({ sql, params })
      return Promise.resolve({ rows: rowsToReturn })
    },
  } as unknown as Pool & { history: FakeQuery[] }
  return pool
}

describe('findUser', () => {
  it('returns the row when the user exists', async () => {
    const pool = makeFakePool([{ id: 'u-1' }])
    const result = await findUser('t-1', 'chat-user-a', pool)
    expect(result).toEqual({ id: 'u-1' })
    expect(pool.history).toHaveLength(1)
    expect(pool.history[0]!.sql).toContain('SELECT')
    expect(pool.history[0]!.sql).not.toContain('INSERT')
    expect(pool.history[0]!.params).toEqual(['t-1', 'chat-user-a'])
  })

  it('returns null when no row exists — never inserts', async () => {
    const pool = makeFakePool([])
    const result = await findUser('t-1', 'chat-user-ghost', pool)
    expect(result).toBeNull()
    // Critical assertion: the lookup must NOT issue an INSERT, since
    // that's what caused the phantom-user retry loop in production.
    expect(pool.history.every((q) => !q.sql.includes('INSERT'))).toBe(true)
  })
})

describe('resolveUser', () => {
  it('upserts and returns the id', async () => {
    const pool = makeFakePool([{ id: 'u-2' }])
    const result = await resolveUser('t-1', 'chat-user-b', pool)
    expect(result).toEqual({ id: 'u-2' })
    expect(pool.history).toHaveLength(1)
    expect(pool.history[0]!.sql).toContain('INSERT')
    expect(pool.history[0]!.sql).toContain('ON CONFLICT')
    expect(pool.history[0]!.params).toEqual(['t-1', 'chat-user-b'])
  })
})
