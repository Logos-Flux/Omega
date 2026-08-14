import pg from 'pg'

const connectionString = process.env.DATABASE_URL

let _pool: pg.Pool | null = null

export function getPool(): pg.Pool {
  if (!_pool) {
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set')
    }
    // DB-32 — bound every query (statement_timeout, server-side) and idle
    // connection. statement_timeout is per-STATEMENT, so it doesn't break the
    // provisioning transaction (whose individual INSERT/UPDATEs are fast; the
    // minutes-long gaps are JS network calls, not SQL).
    _pool = new pg.Pool({
      connectionString,
      statement_timeout: 30_000,
      idleTimeoutMillis: 30_000,
    })
  }
  return _pool
}

export const hasDatabase = !!connectionString
