import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPool, hasDatabase } from './db'

export async function runMigrations(): Promise<void> {
  if (!hasDatabase) {
    console.warn('[migrate] DATABASE_URL not set — skipping migrations')
    return
  }
  const migrationsDir = join(process.cwd(), 'migrations')
  let files: string[]
  try {
    files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  } catch (err) {
    console.warn('[migrate] migrations/ not found, skipping:', (err as Error).message)
    return
  }
  const pool = getPool()
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    console.log(`[migrate] applying ${file}`)
    await pool.query(sql)
  }
  console.log(`[migrate] applied ${files.length} file(s)`)
}
