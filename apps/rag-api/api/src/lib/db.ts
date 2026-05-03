import { Pool } from 'pg'

let pool: Pool | null = null

export function getPool(): Pool {
  if (pool) return pool
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL not set')
  pool = new Pool({ connectionString: url, max: 10 })
  return pool
}
