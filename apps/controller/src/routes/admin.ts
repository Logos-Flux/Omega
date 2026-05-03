import { Hono } from 'hono'
import { getPool, hasDatabase } from '../lib/db'
import { requireAdmin } from '../middleware/admin'

export const adminRoutes = new Hono()

adminRoutes.use('*', requireAdmin)

interface FleetRow {
  release_channel: string
  base_image_version: string | null
  status: string | null
  count: string
}

// /fleet — operator dashboard summary. Three things at once:
//   1. Per-channel user counts.
//   2. Per-(channel, version) container histogram — spot stragglers
//      and stale fleets.
//   3. In-flight + failed update counts from the audit table.
adminRoutes.get('/fleet', async (c) => {
  if (!hasDatabase) return c.json({ error: 'database not configured' }, 503)
  const pool = getPool()

  const [users, containers, audit] = await Promise.all([
    pool.query<{ release_channel: string; count: string }>(
      `SELECT release_channel, COUNT(*)::text as count
       FROM chat.users
       GROUP BY release_channel
       ORDER BY release_channel`,
    ),
    pool.query<FleetRow>(
      `SELECT u.release_channel, c.base_image_version, c.status, COUNT(*)::text as count
       FROM pi.containers c
       JOIN chat.users u ON u.id = c.user_id
       GROUP BY u.release_channel, c.base_image_version, c.status
       ORDER BY u.release_channel, c.base_image_version NULLS FIRST`,
    ),
    pool.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text as count
       FROM pi.update_audit
       WHERE started_at > NOW() - INTERVAL '7 days'
       GROUP BY status`,
    ),
  ])

  return c.json({
    users_by_channel: Object.fromEntries(users.rows.map((r) => [r.release_channel, Number(r.count)])),
    containers: containers.rows.map((r) => ({
      channel: r.release_channel,
      version: r.base_image_version,
      status: r.status,
      count: Number(r.count),
    })),
    updates_last_7d: Object.fromEntries(audit.rows.map((r) => [r.status, Number(r.count)])),
  })
})

// /golden — list of registered manifest versions. Most-recent first.
// Includes `released_to` so the operator can see at a glance which
// versions are on which channels.
adminRoutes.get('/golden', async (c) => {
  if (!hasDatabase) return c.json({ error: 'database not configured' }, 503)
  const res = await getPool().query<{
    version: string
    manifest_uri: string
    manifest_sha: string
    notes: string | null
    built_at: string
    released_to: string[]
    promoted_at: Record<string, string>
    retired_at: string | null
  }>(
    `SELECT version, manifest_uri, manifest_sha, notes, built_at,
            released_to, promoted_at, retired_at
     FROM pi.golden_images
     ORDER BY built_at DESC`,
  )
  return c.json({ goldens: res.rows })
})

// /golden/:version — single manifest detail.
adminRoutes.get('/golden/:version', async (c) => {
  if (!hasDatabase) return c.json({ error: 'database not configured' }, 503)
  const version = c.req.param('version')
  const res = await getPool().query(
    `SELECT version, manifest_uri, manifest_sha, notes, built_at,
            released_to, promoted_at, retired_at
     FROM pi.golden_images WHERE version = $1`,
    [version],
  )
  if (res.rowCount === 0) return c.json({ error: 'not found' }, 404)
  return c.json(res.rows[0])
})

// /users — paginated. Default 50/page, ordered by last_seen_at desc so
// active users surface first. `?channel=alpha` filters.
adminRoutes.get('/users', async (c) => {
  if (!hasDatabase) return c.json({ error: 'database not configured' }, 503)
  const channel = c.req.query('channel')
  const limitRaw = Number(c.req.query('limit') ?? 50)
  const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50), 200)
  const params: unknown[] = []
  let where = ''
  if (channel) {
    params.push(channel)
    where = `WHERE release_channel = $${params.length}`
  }
  params.push(limit)
  const res = await getPool().query(
    `SELECT id, email, name, release_channel, created_at, last_seen_at
     FROM chat.users ${where}
     ORDER BY last_seen_at DESC
     LIMIT $${params.length}`,
    params,
  )
  return c.json({ users: res.rows })
})

// /users/:id — single user detail with container + recent update history.
adminRoutes.get('/users/:id', async (c) => {
  if (!hasDatabase) return c.json({ error: 'database not configured' }, 503)
  const id = c.req.param('id')
  const pool = getPool()

  const [user, container, audit] = await Promise.all([
    pool.query(
      `SELECT id, email, name, release_channel, created_at, last_seen_at
       FROM chat.users WHERE id = $1`,
      [id],
    ),
    pool.query(
      `SELECT user_id, provider, container_name, http_url,
              base_image_version, status, created_at, last_seen_at, last_updated_at
       FROM pi.containers WHERE user_id = $1`,
      [id],
    ),
    pool.query(
      `SELECT id, from_version, to_version, started_at, completed_at, status, error
       FROM pi.update_audit
       WHERE user_id = $1
       ORDER BY started_at DESC
       LIMIT 20`,
      [id],
    ),
  ])

  if (user.rowCount === 0) return c.json({ error: 'not found' }, 404)
  return c.json({
    user: user.rows[0],
    containers: container.rows,
    recent_updates: audit.rows,
  })
})

// ---- Mutating endpoints ----

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/
const VALID_CHANNELS = ['alpha', 'beta', 'launch'] as const
type Channel = (typeof VALID_CHANNELS)[number]

function isChannel(v: unknown): v is Channel {
  return typeof v === 'string' && (VALID_CHANNELS as readonly string[]).includes(v)
}

// POST /golden — register a new manifest. Defaults to released_to=['alpha']
// so a fresh build is never published broadly without an explicit promote.
adminRoutes.post('/golden', async (c) => {
  if (!hasDatabase) return c.json({ error: 'database not configured' }, 503)
  const body = (await c.req.json().catch(() => null)) as {
    version?: string
    manifest_uri?: string
    manifest_sha?: string
    notes?: string
    released_to?: string[]
  } | null
  if (!body) return c.json({ error: 'invalid json body' }, 400)
  const { version, manifest_uri, manifest_sha, notes, released_to } = body

  if (!version || !VERSION_RE.test(version)) {
    return c.json({ error: 'version must be semver (e.g. 1.5.0 or 1.5.0-rc1)' }, 400)
  }
  if (!manifest_uri || typeof manifest_uri !== 'string') {
    return c.json({ error: 'manifest_uri required' }, 400)
  }
  if (!manifest_sha || !/^[a-f0-9]{64}$/.test(manifest_sha)) {
    return c.json({ error: 'manifest_sha must be a 64-char lowercase hex string' }, 400)
  }
  const channels = released_to ?? ['alpha']
  if (!Array.isArray(channels) || !channels.every(isChannel)) {
    return c.json({ error: `released_to must be a subset of ${VALID_CHANNELS.join(',')}` }, 400)
  }

  const promoted: Record<string, string> = {}
  const now = new Date().toISOString()
  for (const ch of channels) promoted[ch] = now

  try {
    const res = await getPool().query(
      `INSERT INTO pi.golden_images (version, manifest_uri, manifest_sha, notes, released_to, promoted_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING version, manifest_uri, manifest_sha, notes, built_at, released_to, promoted_at, retired_at`,
      [version, manifest_uri, manifest_sha, notes ?? null, channels, promoted],
    )
    return c.json(res.rows[0], 201)
  } catch (err) {
    const msg = (err as { code?: string; message: string }).message
    if ((err as { code?: string }).code === '23505') {
      return c.json({ error: `version ${version} already exists` }, 409)
    }
    return c.json({ error: msg }, 500)
  }
})

// POST /golden/:version/promote — add a channel to released_to. Idempotent
// (re-promoting to a channel already in the array is a no-op). Records
// the promotion timestamp in promoted_at.
adminRoutes.post('/golden/:version/promote', async (c) => {
  if (!hasDatabase) return c.json({ error: 'database not configured' }, 503)
  const version = c.req.param('version')
  const body = (await c.req.json().catch(() => null)) as { to?: string } | null
  if (!body || !isChannel(body.to)) {
    return c.json({ error: `body.to required, must be one of ${VALID_CHANNELS.join(',')}` }, 400)
  }
  const channel = body.to
  const res = await getPool().query<{
    version: string
    released_to: string[]
    promoted_at: Record<string, string>
    retired_at: string | null
  }>(
    `UPDATE pi.golden_images
     SET released_to = (
           SELECT array_agg(DISTINCT c) FROM unnest(released_to || ARRAY[$2]::TEXT[]) c
         ),
         promoted_at = jsonb_set(promoted_at, ARRAY[$2], to_jsonb(NOW()::TEXT), true)
     WHERE version = $1
     RETURNING version, released_to, promoted_at, retired_at`,
    [version, channel],
  )
  if (res.rowCount === 0) return c.json({ error: 'version not found' }, 404)
  return c.json(res.rows[0])
})

// POST /golden/:version/retire — sets retired_at. Existing containers on
// that version stay there; new provisions skip retired versions.
adminRoutes.post('/golden/:version/retire', async (c) => {
  if (!hasDatabase) return c.json({ error: 'database not configured' }, 503)
  const version = c.req.param('version')
  const res = await getPool().query(
    `UPDATE pi.golden_images
     SET retired_at = COALESCE(retired_at, NOW())
     WHERE version = $1
     RETURNING version, retired_at`,
    [version],
  )
  if (res.rowCount === 0) return c.json({ error: 'version not found' }, 404)
  return c.json(res.rows[0])
})

// POST /users/:id/channel — move a user between alpha/beta/launch.
adminRoutes.post('/users/:id/channel', async (c) => {
  if (!hasDatabase) return c.json({ error: 'database not configured' }, 503)
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => null)) as { channel?: string } | null
  if (!body || !isChannel(body.channel)) {
    return c.json({ error: `body.channel required, must be one of ${VALID_CHANNELS.join(',')}` }, 400)
  }
  const res = await getPool().query(
    `UPDATE chat.users SET release_channel = $2 WHERE id = $1
     RETURNING id, email, release_channel`,
    [id, body.channel],
  )
  if (res.rowCount === 0) return c.json({ error: 'user not found' }, 404)
  return c.json(res.rows[0])
})

// POST /users/:id/container — upsert a pi.containers row for the user.
// Used by provision-user.ts after a fresh provision lands, and useful
// during testing when an operator needs to map a user to an existing
// sprite without forcing them to hit /api/session/start.
adminRoutes.post('/users/:id/container', async (c) => {
  if (!hasDatabase) return c.json({ error: 'database not configured' }, 503)
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => null)) as {
    provider?: string
    container_name?: string
    http_url?: string
    base_image_version?: string | null
  } | null
  if (!body || !body.provider || !body.container_name) {
    return c.json({ error: 'provider + container_name required' }, 400)
  }
  const res = await getPool().query(
    `INSERT INTO pi.containers (user_id, provider, container_name, http_url, base_image_version)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, provider) DO UPDATE
       SET container_name = EXCLUDED.container_name,
           http_url = EXCLUDED.http_url,
           base_image_version = COALESCE(EXCLUDED.base_image_version, pi.containers.base_image_version),
           last_seen_at = NOW()
     RETURNING user_id, provider, container_name, http_url, base_image_version, status, created_at`,
    [id, body.provider, body.container_name, body.http_url ?? null, body.base_image_version ?? null],
  )
  return c.json(res.rows[0])
})

// DELETE /users/:id/container — remove the row. Caller is responsible
// for any sprite-side cleanup; this only mutates controller state.
adminRoutes.delete('/users/:id/container', async (c) => {
  if (!hasDatabase) return c.json({ error: 'database not configured' }, 503)
  const id = c.req.param('id')
  const provider = c.req.query('provider') ?? 'sprites'
  const res = await getPool().query(
    `DELETE FROM pi.containers WHERE user_id = $1 AND provider = $2
     RETURNING user_id`,
    [id, provider],
  )
  return c.json({ deleted: res.rowCount ?? 0 })
})

// POST /users/:id/applied — record an update apply against the user's
// container. One transaction:
//   1. INSERT pi.update_audit row with the given from/to/status/error
//   2. If status=completed, UPDATE pi.containers.base_image_version
//      + last_updated_at to reflect the new version
// Operator-side scripts call this after running apply-golden + harness
// restart so the controller's view of the fleet stays accurate.
adminRoutes.post('/users/:id/applied', async (c) => {
  if (!hasDatabase) return c.json({ error: 'database not configured' }, 503)
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => null)) as {
    from_version?: string | null
    to_version?: string
    status?: 'running' | 'completed' | 'failed' | 'rolled_back'
    error?: string
  } | null
  if (!body || !body.to_version) {
    return c.json({ error: 'body.to_version required' }, 400)
  }
  const status = body.status ?? 'completed'
  if (!['running', 'completed', 'failed', 'rolled_back'].includes(status)) {
    return c.json({ error: `invalid status: ${status}` }, 400)
  }

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const audit = await client.query<{ id: string }>(
      `INSERT INTO pi.update_audit (user_id, from_version, to_version, status, error,
                                    completed_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 IN ('completed','failed','rolled_back') THEN NOW() ELSE NULL END)
       RETURNING id`,
      [id, body.from_version ?? null, body.to_version, status, body.error ?? null],
    )
    if (status === 'completed') {
      await client.query(
        `UPDATE pi.containers
         SET base_image_version = $2, last_updated_at = NOW(), status = 'active'
         WHERE user_id = $1`,
        [id, body.to_version],
      )
    }
    await client.query('COMMIT')
    return c.json({ audit_id: audit.rows[0]!.id, status, to_version: body.to_version })
  } catch (err) {
    await client.query('ROLLBACK')
    return c.json({ error: (err as Error).message }, 500)
  } finally {
    client.release()
  }
})
