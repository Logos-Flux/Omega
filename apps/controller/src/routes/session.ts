import { Hono } from 'hono'
import { getPool, hasDatabase } from '../lib/db'
import { signSessionToken } from '../lib/jwt'
import { latestGoldenForChannel, type Golden } from '../lib/golden'
import { requireSession } from '../middleware/session'
import { getComputeProvider } from '../compute'
import { bootstrapSprite, type GoldenRef } from '../lib/bootstrap'

export const sessionRoutes = new Hono()

sessionRoutes.use('*', requireSession)

interface ContainerRow {
  user_id: string
  provider: string
  container_name: string
  http_url: string | null
  base_image_version: string | null
  status: string
  created_at: string
  last_seen_at: string
  last_updated_at: string | null
}

async function readContainer(userId: string, providerName: string): Promise<ContainerRow | null> {
  if (!hasDatabase) return null
  const res = await getPool().query<ContainerRow>(
    `SELECT user_id, provider, container_name, http_url,
            base_image_version, status, created_at, last_seen_at, last_updated_at
     FROM pi.containers WHERE user_id = $1 AND provider = $2`,
    [userId, providerName],
  )
  return res.rows[0] ?? null
}

async function upsertContainer(
  userId: string,
  providerName: string,
  containerName: string,
  url: string,
  baseImageVersion: string | null,
): Promise<void> {
  if (!hasDatabase) return
  await getPool().query(
    `INSERT INTO pi.containers (user_id, provider, container_name, http_url, base_image_version)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, provider) DO UPDATE
       SET container_name = EXCLUDED.container_name,
           http_url = EXCLUDED.http_url,
           base_image_version = COALESCE(EXCLUDED.base_image_version, pi.containers.base_image_version),
           last_seen_at = NOW()`,
    [userId, providerName, containerName, url, baseImageVersion],
  )
}

async function bumpLastSeen(userId: string, providerName: string): Promise<void> {
  if (!hasDatabase) return
  await getPool().query(
    `UPDATE pi.containers SET last_seen_at = NOW() WHERE user_id = $1 AND provider = $2`,
    [userId, providerName],
  )
}

async function recordSessionStart(userId: string, containerName: string): Promise<string> {
  if (!hasDatabase) return crypto.randomUUID()
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO pi.sessions (user_id, container_name) VALUES ($1, $2) RETURNING id`,
    [userId, containerName],
  )
  return res.rows[0]!.id
}

async function recordSessionEnd(sessionId: string): Promise<void> {
  if (!hasDatabase) return
  await getPool().query(
    `UPDATE pi.sessions SET ended_at = NOW() WHERE id = $1 AND ended_at IS NULL`,
    [sessionId],
  )
}

function goldenToRef(g: Golden): GoldenRef {
  return { version: g.version, manifestUri: g.manifest_uri }
}

/**
 * Auto-provision path (Phase 0.A.2): no `pi.containers` row exists for
 * this (user, provider). Open a transaction, INSERT the row with
 * `http_url = NULL`, then call `ensureContainer` *outside* the row's
 * UPDATE (still inside the txn so a network failure rolls the row
 * back). If `createSprite` succeeds we bootstrap, UPDATE the row with
 * the resolved URL + version, and COMMIT. Any failure → ROLLBACK so
 * the next sign-in retries cleanly with a clean slate.
 *
 * Postgres holds the row lock for the duration of the network call,
 * which is fine: it's only relevant if the same user fires two
 * concurrent /start calls, in which case the second blocks on the row
 * lock and then sees the inserted row when the first commits.
 */
async function autoProvisionAndBootstrap(args: {
  userId: string
  providerName: string
  ensureContainer: () => Promise<{
    name: string
    url: string
    provider: string
    freshlyProvisioned: boolean
  }>
  golden: Golden | null
  /** Test seam — lets us swap the bootstrap call out without monkey-patching. */
  bootstrap?: typeof bootstrapSprite
}): Promise<{ name: string; url: string; provider: string }> {
  const bootstrap = args.bootstrap ?? bootstrapSprite
  // Bootstrap (apt-install + harness upload + URL flip) only applies to
  // SpritesProvider — Docker containers ship with the harness baked in
  // and don't need any of that orchestration. Skip on every other provider.
  const needsBootstrap = args.providerName === 'sprites'
  if (!hasDatabase) {
    // Dev path with no DB — just create the sprite + bootstrap, no row to rollback.
    const handle = await args.ensureContainer()
    if (handle.freshlyProvisioned && needsBootstrap) {
      if (!args.golden) {
        throw new Error('cannot bootstrap: no golden published for user channel')
      }
      await bootstrap(handle.name, { golden: goldenToRef(args.golden) })
    }
    return handle
  }

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Reserve the row first. container_name uses the deterministic
    // SpritesProvider naming so we can stamp it before the network call.
    // http_url stays NULL until ensureContainer returns. We INSERT
    // ... ON CONFLICT DO NOTHING + RETURNING so a racing call lands
    // safely on the existing-row path the next time around.
    const ins = await client.query<{ user_id: string }>(
      `INSERT INTO pi.containers (user_id, provider, container_name, http_url)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT (user_id, provider) DO NOTHING
       RETURNING user_id`,
      [args.userId, args.providerName, deriveSpriteName(args.userId)],
    )
    if (ins.rows.length === 0) {
      // A concurrent call inserted the row between our readContainer
      // check and the INSERT. Roll back our (no-op) txn and tell the
      // caller to retry the existing-row path.
      await client.query('ROLLBACK')
      throw new ConcurrentProvisionError(
        'pi.containers row was inserted concurrently; retry as existing-row',
      )
    }

    let handle: { name: string; url: string; provider: string; freshlyProvisioned: boolean }
    try {
      handle = await args.ensureContainer()
    } catch (err) {
      // Sprite create failed. ROLLBACK so the next sign-in retries cleanly.
      await client.query('ROLLBACK')
      throw err
    }

    if (handle.freshlyProvisioned && needsBootstrap) {
      if (!args.golden) {
        await client.query('ROLLBACK')
        throw new Error('cannot bootstrap: no golden published for user channel')
      }
      try {
        await bootstrap(handle.name, { golden: goldenToRef(args.golden) })
      } catch (err) {
        // Bootstrap failed. The Sprite EXISTS now (createSprite returned
        // ok), so we keep the row visible — the next sign-in will find
        // an existing row + an existing-but-unhealthy sprite, see
        // freshlyProvisioned=false, and the operator will need to either
        // re-bootstrap manually or destroy + retry. To make this self-
        // healing on the controller path, we COMMIT the row but
        // surface the error so the user sees a clear failure now.
        //
        // Tradeoff: leaving the row visible means the user can't get a
        // clean retry just by re-clicking. The fix is the
        // existing-row-revisit path below: when we detect an existing
        // row and the harness /healthz fails, we re-bootstrap.
        await client.query(
          `UPDATE pi.containers
           SET http_url = $3, base_image_version = $4, last_seen_at = NOW()
           WHERE user_id = $1 AND provider = $2`,
          [args.userId, args.providerName, handle.url, args.golden.version],
        )
        await client.query('COMMIT')
        throw err
      }
    }

    await client.query(
      `UPDATE pi.containers
       SET http_url = $3, base_image_version = $4, last_seen_at = NOW()
       WHERE user_id = $1 AND provider = $2`,
      [args.userId, args.providerName, handle.url, args.golden?.version ?? null],
    )
    await client.query('COMMIT')
    return { name: handle.name, url: handle.url, provider: handle.provider }
  } finally {
    client.release()
  }
}

/**
 * Same deterministic algorithm as `SpritesProvider.spriteNameForUser`.
 * Duplicated here so the auto-provision INSERT can stamp container_name
 * before the network call; if we ever add a non-Sprites provider with a
 * different naming convention this needs to move behind the provider.
 */
function deriveSpriteName(userId: string): string {
  const slug = userId.replace(/-/g, '').slice(0, 12)
  return `harness-${slug}`
}

class ConcurrentProvisionError extends Error {}

sessionRoutes.post('/start', async (c) => {
  const user = c.get('user')
  const provider = getComputeProvider()

  // Resolve the golden the user *should* be on for their channel. NULL
  // means "no golden published to this channel yet" — operator hasn't
  // promoted anything; for fresh-Sprite users this is fatal because we
  // need the manifest to bootstrap. For existing-Sprite users we still
  // let the request through; the row's base_image_version stays
  // whatever it was.
  const golden = await latestGoldenForChannel(user.releaseChannel)

  const existing = await readContainer(user.id, provider.name)

  let handle: { name: string; url: string; provider: string }

  if (!existing) {
    // Auto-provision path — Phase 0.A.2.
    try {
      handle = await autoProvisionAndBootstrap({
        userId: user.id,
        providerName: provider.name,
        ensureContainer: () => provider.ensureContainer(user.id),
        golden,
      })
    } catch (err) {
      if (err instanceof ConcurrentProvisionError) {
        // Race: another /start landed between our read + our INSERT.
        // The other call will (or has) bootstrap. Surface a transient
        // 409 so the client retries; on retry we'll see the existing row.
        return c.json({ error: 'concurrent provisioning in progress; retry' }, 409)
      }
      console.error(`[session] auto-provision failed for user ${user.id}:`, err)
      return c.json({ error: (err as Error).message }, 500)
    }
  } else {
    // Existing-row path. ensureContainer is still called: in the rare
    // case the Sprite was deleted out-of-band (operator destroyed it,
    // org cleanup, etc.), this recreates it AND returns
    // freshlyProvisioned=true → re-bootstrap. Idempotent.
    const ensured = await provider.ensureContainer(user.id)
    if (ensured.freshlyProvisioned) {
      // Sprite was missing; just recreated. Re-bootstrap.
      if (!golden) {
        return c.json(
          {
            error: 'cannot bootstrap: no golden published for user channel',
            sprite: ensured.name,
          },
          503,
        )
      }
      try {
        await bootstrapSprite(ensured.name, { golden: goldenToRef(golden) })
      } catch (err) {
        console.error(`[session] re-bootstrap failed for ${ensured.name}:`, err)
        return c.json({ error: (err as Error).message, sprite: ensured.name }, 500)
      }
    }
    await upsertContainer(
      user.id,
      ensured.provider,
      ensured.name,
      ensured.url,
      golden?.version ?? null,
    )
    handle = { name: ensured.name, url: ensured.url, provider: ensured.provider }
  }

  const sessionId = await recordSessionStart(user.id, handle.name)
  const token = signSessionToken({ userId: user.id, sessionId })

  return c.json({
    sessionId,
    token,
    container: {
      name: handle.name,
      url: handle.url,
      provider: handle.provider,
    },
    target_version: golden?.version ?? null,
  })
})

sessionRoutes.post('/heartbeat', async (c) => {
  const user = c.get('user')
  const provider = getComputeProvider()
  await bumpLastSeen(user.id, provider.name)
  return c.json({ ok: true })
})

sessionRoutes.post('/stop', async (c) => {
  const user = c.get('user')
  const provider = getComputeProvider()
  const body = (await c.req.json().catch(() => ({}))) as { sessionId?: string }
  const row = await readContainer(user.id, provider.name)
  if (row) {
    await provider.freeze(row.container_name).catch((e) =>
      console.warn('[session] freeze failed', e),
    )
  }
  if (body.sessionId) await recordSessionEnd(body.sessionId)
  return c.json({ ok: true })
})

sessionRoutes.get('/status', async (c) => {
  const user = c.get('user')
  const provider = getComputeProvider()
  const row = await readContainer(user.id, provider.name)
  if (!row) return c.json({ container: null, status: 'gone' as const })

  const status = await provider.status(row.container_name).catch(() => 'gone' as const)
  return c.json({
    container: {
      name: row.container_name,
      url: row.http_url,
      provider: row.provider,
      lastSeenAt: row.last_seen_at,
    },
    status,
  })
})
