import pg from 'pg'

const connectionString = process.env.DATABASE_URL

let _pool: pg.Pool | null = null

export function getPool(): pg.Pool {
  if (!_pool) {
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set')
    }
    _pool = new pg.Pool({ connectionString })
  }
  return _pool
}

export const hasDatabase = !!connectionString
