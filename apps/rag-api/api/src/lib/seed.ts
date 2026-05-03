import { getPool } from './db'
import { sha256Hex } from '../middleware/tenant'

// Boot-time idempotent seeding. Migrations create the schema + the
// 'omega' tenant row. This file ensures runtime values that depend
// on env vars are reflected in the DB:
//
//  - sha256(ADMIN_BEARER_TOKEN) is upserted into rag.api_keys so the
//    same token used at the Caddy edge resolves to a real tenant row.
//
// Idempotent — safe to run on every boot. If ADMIN_BEARER_TOKEN
// rotates, the old hash sticks around (revoke manually); the new one
// is added.

export async function seedAdminApiKey(): Promise<void> {
  const token = process.env.ADMIN_BEARER_TOKEN ?? ''
  if (!token) {
    console.warn('[seed] ADMIN_BEARER_TOKEN not set; skipping api_keys seed')
    return
  }

  const pool = getPool()
  const hash = sha256Hex(token)

  // Look up the seeded tenant. If migration 0002 ran, it exists.
  const tenant = await pool.query<{ id: string }>(
    `SELECT id FROM rag.tenants WHERE slug = $1`,
    ['omega'],
  )
  if (tenant.rows.length === 0) {
    console.warn("[seed] tenant 'omega' missing; migration 0002 may not have run")
    return
  }
  const tenantId = tenant.rows[0]!.id

  await pool.query(
    `INSERT INTO rag.api_keys (tenant_id, token_sha256, label)
     VALUES ($1, $2, 'admin (env: ADMIN_BEARER_TOKEN)')
     ON CONFLICT (token_sha256) DO NOTHING`,
    [tenantId, hash],
  )
  console.log('[seed] admin api key ensured')
}
