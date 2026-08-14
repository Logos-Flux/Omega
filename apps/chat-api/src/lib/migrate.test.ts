import { describe, expect, test, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { runMigrations } from './migrate'

// DB-07 — the tracked, transactional, advisory-locked migrator. These tests
// drive it with a fake pool/client (no Postgres) and a temp migrations dir.

const dir = mkdtempSync(join(tmpdir(), 'chatapi-migrate-'))
writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE IF NOT EXISTS chat.a (id int);')
writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE IF NOT EXISTS chat.b (id int);')
process.env.MIGRATIONS_DIR = dir

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.MIGRATIONS_DIR
})

// A fake pool whose single client records every query and simulates the
// public.schema_migrations ledger via an in-memory set.
function makeFakePool() {
  const applied = new Set<string>()
  const queries: string[] = []
  let locked = false
  let lockEverHeld = false
  const client = {
    async query(sql: string, params?: unknown[]) {
      queries.push(sql.trim().split('\n')[0]!.trim())
      if (/pg_advisory_lock\(/.test(sql)) { locked = true; lockEverHeld = true; return { rows: [] } }
      if (/pg_advisory_unlock\(/.test(sql)) { locked = false; return { rows: [] } }
      if (/SELECT 1 FROM public\.schema_migrations/.test(sql)) {
        const file = (params as string[])[1]!
        return { rows: applied.has(file) ? [{ '?column?': 1 }] : [] }
      }
      if (/INSERT INTO public\.schema_migrations/.test(sql)) {
        applied.add((params as string[])[1]!)
        return { rows: [] }
      }
      return { rows: [] }
    },
    release() {},
  }
  const pool = {
    connect: async () => client,
    get _isLockedNow() { return locked },
    get _lockEverHeld() { return lockEverHeld },
    _queries: queries,
    _applied: applied,
  }
  return pool as unknown as Pool & {
    _isLockedNow: boolean
    _lockEverHeld: boolean
    _queries: string[]
    _applied: Set<string>
  }
}

describe('runMigrations (DB-07)', () => {
  test('first run applies every file once, in a txn, recording each', async () => {
    const pool = makeFakePool()
    await runMigrations(pool)
    expect(pool._applied.has('0001_a.sql')).toBe(true)
    expect(pool._applied.has('0002_b.sql')).toBe(true)
    // Each apply is wrapped BEGIN…COMMIT.
    expect(pool._queries.filter((q) => q === 'BEGIN').length).toBe(2)
    expect(pool._queries.filter((q) => q === 'COMMIT').length).toBe(2)
  })

  test('acquires the advisory lock and releases it', async () => {
    const pool = makeFakePool()
    await runMigrations(pool)
    expect(pool._lockEverHeld).toBe(true)
    expect(pool._isLockedNow).toBe(false) // released in finally
  })

  test('second run with everything already applied is a no-op (no BEGIN)', async () => {
    const pool = makeFakePool()
    pool._applied.add('0001_a.sql')
    pool._applied.add('0002_b.sql')
    await runMigrations(pool)
    expect(pool._queries.filter((q) => q === 'BEGIN').length).toBe(0)
  })
})
