import pg from 'pg'

const connectionString = process.env.DATABASE_URL

let _pool: pg.Pool | null = null

export function getPool(): pg.Pool {
  if (!_pool) {
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set')
    }
    // DB-32 — bound every query and idle connection so one slow/hung statement
    // can't pin a pool client indefinitely. statement_timeout is enforced
    // server-side (ms).
    _pool = new pg.Pool({
      connectionString,
      statement_timeout: 30_000,
      idleTimeoutMillis: 30_000,
    })
  }
  return _pool
}

export const hasDatabase = !!connectionString
