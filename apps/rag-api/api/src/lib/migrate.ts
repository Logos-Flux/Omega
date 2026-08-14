import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getPool } from './db'

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? 'migrations'

// DB-07 — serialise overlapping migrators on a session-level advisory lock.
// rag-api + rag-ingest now deploy via the pinned pipeline (M4), so Fly's
// deploy overlap (new machine boots before the old stops) can race two
// migrators against the same `rag` DB; the lock makes the second wait, then
// it sees every file already recorded and applies nothing.
const LOCK_KEY = 'rag-api-migrate'

export async function runMigrations(): Promise<void> {
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY])
    await client.query(`
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
      const { rows } = await client.query<{ filename: string }>(
        'SELECT filename FROM rag.schema_migrations WHERE filename = $1',
        [file],
      )
      if (rows.length > 0) continue

      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO rag.schema_migrations(filename) VALUES ($1)', [file])
        await client.query('COMMIT')
        console.log(`migration applied: ${file}`)
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => {})
    client.release()
  }
}
