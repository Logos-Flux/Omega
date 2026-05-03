/**
 * I.D.1 — per-thread provider lock-in. Unit-level tests for the resolver.
 *
 * The resolver is the only stateful part of the locking logic; the route
 * handler is a thin wrapper that hands the resolution off to streamText.
 * Mocking the pool keeps these tests hermetic — no Postgres required.
 *
 * Run with: bun test src/lib/thread-lock.test.ts
 */
import { describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'
import { resolveThreadLock } from './thread-lock'

interface MockRow {
  provider: string | null
  model: string | null
  title?: string
}

interface FakePoolHistory {
  queries: Array<{ sql: string; params: unknown[] }>
}

function makeFakePool(initialRow: MockRow | null): Pool & FakePoolHistory {
  let row: MockRow | null = initialRow
  const queries: Array<{ sql: string; params: unknown[] }> = []

  const fake = {
    queries,
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params })
      const isSelect = /^\s*SELECT/i.test(sql)
      if (isSelect) {
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
      }
      const isInsert = /^\s*INSERT/i.test(sql)
      const isUpdate = /^\s*UPDATE/i.test(sql)
      if (isInsert) {
        // Mirror the chat-api migration's `ON CONFLICT (id) DO UPDATE`
        // semantics — first INSERT wins, subsequent INSERT-with-conflict
        // would coalesce, but our resolver always SELECTs first so we
        // only hit the INSERT branch when the row doesn't exist yet.
        const [, , title, provider, model] = params as [string, string, string, string, string]
        row = { provider, model, title }
      } else if (isUpdate) {
        // Two shapes: the lock-update (`SET provider=$1, model=$2`) and the
        // touch-only (`SET updated_at=NOW()`). Distinguish by SQL.
        if (/SET provider/i.test(sql)) {
          const [provider, model] = params as [string, string]
          row = { ...(row ?? { provider: null, model: null }), provider, model }
        }
        // touch-only: no row mutation needed
      }
      return { rows: [], rowCount: 0 }
    },
  }
  // Cast through unknown — we only implement the slice the resolver uses.
  return fake as unknown as Pool & FakePoolHistory
}

const baseArgs = {
  threadId: 't1',
  userId: 'u1',
  firstUserMessage: 'hello there',
}

describe('resolveThreadLock', () => {
  it('first turn of a new thread locks to the requested pair', async () => {
    const pool = makeFakePool(null)
    const out = await resolveThreadLock({
      ...baseArgs,
      requestedProvider: 'anthropic',
      requestedModel: 'claude-opus-4-7',
      override: false,
      pool,
    })
    expect(out).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      mismatched: false,
    })
    // Sanity: the resolver issued an INSERT.
    const insertCount = pool.queries.filter((q) => /^\s*INSERT/i.test(q.sql)).length
    expect(insertCount).toBe(1)
  })

  it('legacy thread with NULL lock columns gets locked on next turn', async () => {
    const pool = makeFakePool({ provider: null, model: null })
    const out = await resolveThreadLock({
      ...baseArgs,
      requestedProvider: 'google',
      requestedModel: 'gemini-3.1-pro-preview',
      override: false,
      pool,
    })
    expect(out).toEqual({
      provider: 'google',
      model: 'gemini-3.1-pro-preview',
      mismatched: false,
    })
  })

  it('subsequent turn with same pair passes through unchanged', async () => {
    const pool = makeFakePool({ provider: 'anthropic', model: 'claude-opus-4-7' })
    const out = await resolveThreadLock({
      ...baseArgs,
      requestedProvider: 'anthropic',
      requestedModel: 'claude-opus-4-7',
      override: false,
      pool,
    })
    expect(out).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      mismatched: false,
    })
    // No lock-update SQL.
    const lockUpdates = pool.queries.filter((q) => /SET provider/i.test(q.sql))
    expect(lockUpdates).toHaveLength(0)
  })

  it('mid-thread switch with no override → request rewritten to locked values + mismatched', async () => {
    const pool = makeFakePool({ provider: 'anthropic', model: 'claude-opus-4-7' })
    const out = await resolveThreadLock({
      ...baseArgs,
      requestedProvider: 'google',
      requestedModel: 'gemini-3.1-pro-preview',
      override: false,
      pool,
    })
    expect(out).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      mismatched: true,
    })
    // No lock-update SQL was issued — the locked values are preserved.
    const lockUpdates = pool.queries.filter((q) => /SET provider/i.test(q.sql))
    expect(lockUpdates).toHaveLength(0)
  })

  it('mid-thread switch with override:true re-locks to the new pair', async () => {
    const pool = makeFakePool({ provider: 'anthropic', model: 'claude-opus-4-7' })
    const out = await resolveThreadLock({
      ...baseArgs,
      requestedProvider: 'google',
      requestedModel: 'gemini-3.1-pro-preview',
      override: true,
      pool,
    })
    expect(out).toEqual({
      provider: 'google',
      model: 'gemini-3.1-pro-preview',
      mismatched: false,
    })
    const lockUpdates = pool.queries.filter((q) => /SET provider/i.test(q.sql))
    expect(lockUpdates).toHaveLength(1)
  })
})
