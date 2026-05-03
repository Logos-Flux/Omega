import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getPool } from './db'

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? 'migrations'

export async function runMigrations(): Promise<void> {
  const pool = getPool()
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS rag;
    CREATE TABLE IF NOT EXISTS rag.schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const { rows } = await pool.query<{ filename: string }>(
      'SELECT filename FROM rag.schema_migrations WHERE filename = $1',
      [file],
    )
    if (rows.length > 0) continue

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO rag.schema_migrations(filename) VALUES ($1)', [file])
      await client.query('COMMIT')
      console.log(`migration applied: ${file}`)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
}
