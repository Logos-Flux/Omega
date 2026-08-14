import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { getPool, hasDatabase } from './db'

// DB-07 — tracked, transactional, advisory-locked migrator (ports the rag-api
// pattern). The previous migrator re-ran EVERY .sql file on EVERY boot, with no
// ledger, no per-file transaction, and no lock:
//   - any future non-idempotent statement would break every subsequent boot;
//   - a mid-file crash left half-applied DDL with no record;
//   - Fly's deploy overlap (new machine boots before the old one stops) raced
//     two migrators against the same database.
// The existing migration files are all idempotent (they survived re-running
// every boot), so the first run under this migrator re-applies them once more
// (safe) and records them in the ledger; subsequent boots skip applied files.
//
// The ledger is a single shared table keyed by (app, filename) because chat-api
// and the controller share one database — each app records only its own files.

const APP = 'chat-api'
const LOCK_KEY = `${APP}-migrate`

export async function runMigrations(injectedPool?: Pool): Promise<void> {
  if (!hasDatabase && !injectedPool) {
    console.warn('[migrate] DATABASE_URL not set — skipping migrations')
    return
  }
  const pool = injectedPool ?? getPool()
  const client = await pool.connect()
  try {
    // Serialise concurrent migrators (overlapping deploys) on a session-level
    // advisory lock. The second migrator blocks here until the first releases,
    // then sees every file already recorded and applies nothing.
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY])
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        app TEXT NOT NULL,
        filename TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (app, filename)
      );
    `)

    const dir = process.env.MIGRATIONS_DIR ?? join(process.cwd(), 'migrations')
    let files: string[]
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
    } catch (err) {
      console.warn('[migrate] migrations/ not found, skipping:', (err as Error).message)
      return
    }

    let applied = 0
    for (const file of files) {
      const { rows } = await client.query(
        'SELECT 1 FROM public.schema_migrations WHERE app = $1 AND filename = $2',
        [APP, file],
      )
      if (rows.length > 0) continue
      const sql = await readFile(join(dir, file), 'utf8')
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO public.schema_migrations(app, filename) VALUES ($1, $2)', [APP, file])
        await client.query('COMMIT')
        applied++
        console.log(`[migrate] applied ${file}`)
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
    }
    console.log(`[migrate] up to date (${applied} newly applied, ${files.length} total)`)
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => {})
    client.release()
  }
}
