import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getPool, hasDatabase } from './db'

// DB-07 — tracked, transactional, advisory-locked migrator (ports the rag-api
// pattern). See apps/chat-api/src/lib/migrate.ts for the full rationale. The
// previous migrator re-ran every .sql file on every boot, untracked, with no
// per-file transaction and no lock against Fly's deploy-overlap races.
//
// The controller and chat-api share one database; the ledger is keyed by
// (app, filename) so each app records only its own files. The controller's
// migrations deliberately (re)declare chat.users via IF NOT EXISTS for its FKs
// — that stays idempotent regardless of which app migrates first (DB-09).

const APP = 'controller'
const LOCK_KEY = `${APP}-migrate`

export async function runMigrations(): Promise<void> {
  if (!hasDatabase) {
    console.warn('[migrate] DATABASE_URL not set — skipping migrations')
    return
  }
  const pool = getPool()
  const client = await pool.connect()
  try {
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
