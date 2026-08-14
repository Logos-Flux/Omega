import { Hono } from 'hono'
import { getPool, hasDatabase } from '../lib/db'
import { signSessionToken } from '../lib/jwt'
import { latestGoldenForChannel, type Golden } from '../lib/golden'
import { requireSession } from '../middleware/session'
import { getComputeProvider } from '../compute'
import { bootstrapSprite, type GoldenRef } from '../lib/bootstrap'
import { harnessHealthy } from '../lib/harness-health'

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

/**
 * Resume an existing session instead of minting a new one. Returns the session
 * id iff it exists AND belongs to `userId` — so a client can't resume (and have
 * a token minted for) someone else's session. Returns null when the id is
 * unknown / not the user's, so the caller falls back to a fresh session.
 * Without a DB we can't verify ownership, so we refuse to resume (return null).
 */
async function resumeSessionIfOwned(
  sessionId: string,
  userId: string,
): Promise<string | null> {
  if (!hasDatabase) return null
  const res = await getPool().query<{ id: string }>(
    `SELECT id FROM pi.sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, userId],
  )
  return res.rows[0]?.id ?? null
}

async function recordSessionEnd(sessionId: string, userId: string): Promise<void> {
  if (!hasDatabase) return
  // BUG-23 — scope to the calling user so a client-supplied sessionId can only
  // end the caller's own session row, never an arbitrary one.
  await getPool().query(
    `UPDATE pi.sessions SET ended_at = NOW() WHERE id = $1 AND user_id = $2 AND ended_at IS NULL`,
    [sessionId, userId],
  )
}

function goldenToRef(g: Golden): GoldenRef {
  return { version: g.version, manifestUri: g.manifest_uri }
}

// DB-25 — how long a 'provisioning' row may sit before the next /start treats
// it as abandoned (process died mid-provision) and takes it over rather than
// 409'ing forever. Cold-sprite bootstrap is comfortably under this.
const STALE_PROVISIONING_MS = 15 * 60 * 1000

/**
 * Reserve a provisioning row in a SHORT, committed transaction — no network
 * work runs while the pool client is held (DB-25). Returns:
 *   'reserved'   — we now own provisioning (fresh INSERT, or takeover of a
 *                  stale abandoned row); proceed to create + bootstrap.
 *   'concurrent' — another /start is genuinely provisioning right now (a fresh
 *                  'provisioning' row, or a finalized 'active' row appeared);
 *                  caller surfaces a transient 409 / retries the existing-row
 *                  path.
 */
async function reserveProvisioningRow(
  userId: string,
  providerName: string,
): Promise<'reserved' | 'concurrent'> {
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // container_name uses the deterministic SpritesProvider naming so it's
    // stamped before any network call. http_url stays NULL until finalize.
    const ins = await client.query<{ user_id: string }>(
      `INSERT INTO pi.containers
         (user_id, provider, container_name, http_url, status, provisioning_started_at)
       VALUES ($1, $2, $3, NULL, 'provisioning', NOW())
       ON CONFLICT (user_id, provider) DO NOTHING
       RETURNING user_id`,
      [userId, providerName, deriveSpriteName(userId)],
    )
    if (ins.rows.length > 0) {
      await client.query('COMMIT')
      return 'reserved'
    }
    // A row already exists. Take it over ONLY if it's a stale provisioning row
    // (an earlier attempt died); an 'active' row or a fresh in-flight
    // 'provisioning' row is genuinely concurrent.
    const taken = await client.query<{ user_id: string }>(
      `UPDATE pi.containers
       SET provisioning_started_at = NOW(), http_url = NULL
       WHERE user_id = $1 AND provider = $2 AND status = 'provisioning'
         AND provisioning_started_at < NOW() - make_interval(secs => $3)
       RETURNING user_id`,
      [userId, providerName, STALE_PROVISIONING_MS / 1000],
    )
    await client.query('COMMIT')
    return taken.rows.length > 0 ? 'reserved' : 'concurrent'
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Drop our still-provisioning reservation so the next /start retries cleanly.
 *  Guarded on status='provisioning' so we never delete a row another path
 *  already finalized to 'active'. */
async function releaseProvisioningRow(userId: string, providerName: string): Promise<void> {
  if (!hasDatabase) return
  await getPool().query(
    `DELETE FROM pi.containers
     WHERE user_id = $1 AND provider = $2 AND status = 'provisioning'`,
    [userId, providerName],
  )
}

/** Finalize a reserved row to 'active' with the resolved URL. base_image_version
 *  is stamped only when a bootstrap actually ran (OPS-24a: null → keep prior),
 *  and last_updated_at advances only then for the same reason. */
async function finalizeProvisioningRow(
  userId: string,
  providerName: string,
  url: string,
  baseImageVersion: string | null,
): Promise<void> {
  await getPool().query(
    `UPDATE pi.containers
     SET http_url = $3,
         status = 'active',
         provisioning_started_at = NULL,
         base_image_version = COALESCE($4, base_image_version),
         last_updated_at = CASE WHEN $4 IS NOT NULL THEN NOW() ELSE last_updated_at END,
         last_seen_at = NOW()
     WHERE user_id = $1 AND provider = $2`,
    [userId, providerName, url, baseImageVersion],
  )
}

/**
 * Auto-provision path (Phase 0.A.2): no usable `pi.containers` row exists for
 * this (user, provider) — either none at all, or a stale 'provisioning' row.
 *
 * DB-25: the slow sprite-create + bootstrap network calls (5-30s on a cold
 * sprite) no longer run inside a transaction holding a pool connection. Instead:
 *   1. reserve the row in a SHORT committed txn (status='provisioning');
 *   2. create the sprite + bootstrap with NO db client held;
 *   3. finalize the row to 'active' (or drop it on failure so /start retries).
 * A concurrent /start that loses the reserve race gets a transient 409; an
 * abandoned 'provisioning' row is taken over after STALE_PROVISIONING_MS.
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
    // Dev path with no DB — just create the sprite + bootstrap, no row to track.
    const handle = await args.ensureContainer()
    if (handle.freshlyProvisioned && needsBootstrap) {
      if (!args.golden) {
        throw new Error('cannot bootstrap: no golden published for user channel')
      }
      await bootstrap(handle.name, { golden: goldenToRef(args.golden), userId: args.userId })
    }
    return handle
  }

  // 1. Reserve (short txn, no network, client released immediately).
  if ((await reserveProvisioningRow(args.userId, args.providerName)) === 'concurrent') {
    throw new ConcurrentProvisionError(
      'pi.containers row is being provisioned concurrently; retry as existing-row',
    )
  }

  // 2. Network work — NO db client held for its duration.
  let handle: { name: string; url: string; provider: string; freshlyProvisioned: boolean }
  try {
    handle = await args.ensureContainer()
  } catch (err) {
    // Sprite create failed. Drop the reservation so the next sign-in retries.
    await releaseProvisioningRow(args.userId, args.providerName)
    throw err
  }

  // Bootstrap when the sprite is fresh, OR (BUG-13) it already existed as an
  // orphan whose harness never came up — probe and re-bootstrap so /start never
  // hands back a URL with a dead harness.
  let bootstrapped = false
  const orphanDown =
    needsBootstrap && !handle.freshlyProvisioned && !(await harnessHealthy(handle.url))
  if (needsBootstrap && (handle.freshlyProvisioned || orphanDown)) {
    if (!args.golden) {
      // Can't bootstrap without a manifest. Drop the reservation; fatal.
      await releaseProvisioningRow(args.userId, args.providerName)
      throw new Error('cannot bootstrap: no golden published for user channel')
    }
    try {
      await bootstrap(
        handle.name,
        handle.freshlyProvisioned
          ? { golden: goldenToRef(args.golden), userId: args.userId }
          : { golden: goldenToRef(args.golden) },
      )
      bootstrapped = true
    } catch (err) {
      // The sprite EXISTS now but its harness didn't come up. Finalize the row
      // to 'active' (visible) so the existing-row self-heal path re-bootstraps
      // on the next /start; surface the error now.
      await finalizeProvisioningRow(
        args.userId,
        args.providerName,
        handle.url,
        args.golden.version,
      )
      throw err
    }
  }

  // 3. Finalize. Stamp base_image_version only when a bootstrap ran (OPS-24a).
  const stampedVersion =
    handle.freshlyProvisioned || bootstrapped ? (args.golden?.version ?? null) : null
  await finalizeProvisioningRow(args.userId, args.providerName, handle.url, stampedVersion)
  return { name: handle.name, url: handle.url, provider: handle.provider }
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

  // Optional: resume a specific past session (the agent-mode thread switcher
  // sends this). Validated against pi.sessions for ownership below — an
  // unknown / not-yours id silently falls back to a fresh session.
  const startBody = (await c.req.json().catch(() => ({}))) as { resumeSessionId?: string }
  const resumeSessionId =
    typeof startBody.resumeSessionId === 'string' && startBody.resumeSessionId.length > 0
      ? startBody.resumeSessionId
      : null

  // Resolve the golden the user *should* be on for their channel. NULL
  // means "no golden published to this channel yet" — operator hasn't
  // promoted anything; for fresh-Sprite users this is fatal because we
  // need the manifest to bootstrap. For existing-Sprite users we still
  // let the request through; the row's base_image_version stays
  // whatever it was.
  const golden = await latestGoldenForChannel(user.releaseChannel)

  const existing = await readContainer(user.id, provider.name)

  let handle: { name: string; url: string; provider: string }

  // DB-25 — a row stuck in 'provisioning' (http_url still NULL) is not a usable
  // sprite: it's either an in-flight reserve or an abandoned one. Route it
  // through the provision path, which reserves/takes-over (stale) or 409s
  // (fresh concurrent) — never down the existing-row path with a NULL url.
  if (!existing || existing.status === 'provisioning') {
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
    // Re-bootstrap when either:
    //  (a) the Sprite was freshly recreated (deleted out-of-band), or
    //  (b) the Sprite still exists but its harness isn't answering — the
    //      common case: the Sprite went `cold` on idle, which kills the
    //      foreground harness process, and nothing inside the Sprite
    //      restarts it on warm-up. Without this, a returning user gets the
    //      URL of a Sprite whose harness is dead and the browser WS upgrade
    //      hangs forever. The health probe only applies to the Sprites
    //      provider (Docker containers keep the harness alive via their own
    //      supervisor). bootstrapSprite is idempotent: it kills any stale
    //      session, restarts the harness, and verifies /healthz.
    const harnessDown =
      provider.name === 'sprites' &&
      !ensured.freshlyProvisioned &&
      !(await harnessHealthy(ensured.url))
    const didBootstrap = ensured.freshlyProvisioned || harnessDown
    if (didBootstrap) {
      // Sprite was missing or its harness is dead. (Re-)bootstrap.
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
        await bootstrapSprite(ensured.name, { golden: goldenToRef(golden), userId: user.id })
      } catch (err) {
        console.error(`[session] re-bootstrap failed for ${ensured.name}:`, err)
        return c.json({ error: (err as Error).message, sprite: ensured.name }, 500)
      }
    }
    // OPS-24a — only stamp base_image_version when a bootstrap ACTUALLY ran.
    // On the warm-healthy path no golden was applied, so writing the latest
    // version would lie: the sprite keeps running whatever golden it had
    // (apply-golden doesn't restart a running harness — the warm-pkill gap),
    // making fleet rollouts unverifiable and bad goldens untriageable by
    // cohort. Pass null → upsertContainer COALESCEs to keep the recorded value.
    await upsertContainer(
      user.id,
      ensured.provider,
      ensured.name,
      ensured.url,
      didBootstrap ? (golden?.version ?? null) : null,
    )
    handle = { name: ensured.name, url: ensured.url, provider: ensured.provider }
  }

  // Resume the requested session if it's the user's; otherwise mint a new one.
  const sessionId =
    (resumeSessionId && (await resumeSessionIfOwned(resumeSessionId, user.id))) ||
    (await recordSessionStart(user.id, handle.name))
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
  if (body.sessionId) await recordSessionEnd(body.sessionId, user.id)
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
