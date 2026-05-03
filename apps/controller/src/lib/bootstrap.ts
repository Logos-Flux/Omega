// Fresh-Sprite bootstrap path.
//
// Phase 0.A.1 deliverable. Invoked from `/api/session/start` whenever
// `provider.ensureContainer(userId)` returns `freshlyProvisioned: true`.
// A fresh Sprite is a bare Ubuntu container — no apt deps, no harness
// binary, no version stamp. Bootstrap takes it from "just-created" to
// "harness is up and answering /healthz".
//
// Single source of truth for the apt/npm/bundle/fs steps is the existing
// `scripts/apply-golden.ts` (the same path operators use today via
// `provision-user.ts` and `update-user.ts`). This module spawns it as a
// subprocess so we don't fork the install logic. On top of that we add
// the pieces apply-golden does NOT do: starting the harness session,
// flipping the sprite URL to auth=public, and verifying /healthz.
//
// Idempotency: re-running on a partially-bootstrapped Sprite is safe.
// apply-golden re-checks every package/file. Harness start kills any
// existing session before booting a fresh one. URL auth flip is a no-op
// when already public.
//
// Production gap (documented in CLAUDE.md): the controller's runtime
// Docker image does NOT yet include the `sprite` CLI binary that
// apply-golden + the harness-start step shell out to. Until that lands,
// this code path works in dev / on-host / via operator-driven
// `provision-user.ts` invocation, but `/api/session/start` will fail
// closed for fresh-Sprite users in deployed prod. The fix is a one-line
// `RUN curl … sprite` install in the Dockerfile (or vendoring the
// binary), tracked alongside Phase 0.A.1 cutover.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface GoldenRef {
  version: string
  manifestUri: string
}

export interface BootstrapOptions {
  golden: GoldenRef
  /** Override the apply-golden command (tests inject a no-op). */
  runApplyGolden?: ApplyGoldenRunner
  /** Override the sprite CLI runner (tests inject a stub). */
  spriteCli?: SpriteCliRunner
  /** Override the healthz fetcher (tests inject a stub). */
  fetchHealthz?: HealthzFetcher
  /** Override the URL resolver (tests inject a stub). */
  fetchSpriteUrl?: SpriteUrlFetcher
  /** Total timeout for the healthz wait, in ms. Defaults to 60000. */
  healthzTimeoutMs?: number
  /** Per-attempt sleep for the healthz poll, in ms. Defaults to 2000. */
  healthzPollIntervalMs?: number
  /** Repo root override for resolving `file://` manifests. Defaults to controller package root. */
  repoRoot?: string
  /** Provider-supplied env vars for the harness. Tests inject a stub. */
  resolveHarnessEnv?: HarnessEnvResolver
}

export type ApplyGoldenRunner = (args: {
  spriteName: string
  version: string
  manifestPath: string
  repoRoot: string
}) => SpawnSyncReturns<string>

export type SpriteCliRunner = (args: string[]) => SpawnSyncReturns<string>
export type HealthzFetcher = (url: string) => Promise<{ ok: boolean; status: number; body: string }>
export type SpriteUrlFetcher = (spriteName: string) => Promise<string>
export type HarnessEnvResolver = () => Record<string, string>

class BootstrapError extends Error {
  constructor(
    public readonly step: string,
    message: string,
  ) {
    super(`[bootstrap] ${step}: ${message}`)
    this.name = 'BootstrapError'
  }
}

const DEFAULT_REPO_ROOT = (() => {
  const here = dirname(fileURLToPath(import.meta.url))
  // src/lib/bootstrap.ts → controller/
  return join(here, '..', '..')
})()

function resolveManifestPath(manifestUri: string, repoRoot: string): string {
  if (manifestUri.startsWith('file://')) {
    const rel = manifestUri.slice('file://'.length)
    return isAbsolute(rel) ? rel : join(repoRoot, rel)
  }
  throw new BootstrapError('resolve-manifest', `unsupported manifest_uri scheme: ${manifestUri}`)
}

const defaultApplyGolden: ApplyGoldenRunner = ({ spriteName, version, manifestPath, repoRoot }) =>
  spawnSync(
    'bun',
    [join(repoRoot, 'scripts', 'apply-golden.ts'), spriteName, version, manifestPath],
    { stdio: 'inherit', cwd: repoRoot, encoding: 'utf8' },
  )

const defaultSpriteCli: SpriteCliRunner = (args) =>
  spawnSync('sprite', args, { encoding: 'utf8' })

const defaultFetchHealthz: HealthzFetcher = async (url) => {
  const res = await fetch(url)
  const body = await res.text().catch(() => '')
  return { ok: res.ok, status: res.status, body }
}

const defaultFetchSpriteUrl: SpriteUrlFetcher = async (spriteName) => {
  const token = process.env.SPRITES_API_TOKEN
  if (!token) throw new BootstrapError('fetch-url', 'SPRITES_API_TOKEN not set')
  const res = await fetch(
    `https://api.sprites.dev/v1/sprites/${encodeURIComponent(spriteName)}`,
    { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
  )
  if (!res.ok) {
    throw new BootstrapError('fetch-url', `GET sprite failed: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as { url?: string }
  if (!body.url) throw new BootstrapError('fetch-url', 'sprite record has no url')
  return body.url
}

const defaultResolveHarnessEnv: HarnessEnvResolver = () => {
  const env: Record<string, string> = {
    WORKSPACE_ROOT: '/workspace',
    PORT: '8080',
  }
  for (const k of [
    'ANTHROPIC_API_KEY',
    'GOOGLE_API_KEY',
    'PERPLEXITY_API_KEY',
    'HARNESS_JWT_SECRET',
  ]) {
    const v = process.env[k]
    if (v) env[k] = v
  }
  return env
}

function envToFlag(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
}

/**
 * Bootstrap a freshly-provisioned Sprite. Idempotent and safe to re-run.
 *
 * Throws `BootstrapError` on any step failure; the caller (`/start`)
 * decides whether to surface it to the user or keep the DB row for the
 * next retry.
 */
export async function bootstrapSprite(spriteName: string, opts: BootstrapOptions): Promise<void> {
  const repoRoot = opts.repoRoot ?? DEFAULT_REPO_ROOT
  const runApplyGolden = opts.runApplyGolden ?? defaultApplyGolden
  const spriteCli = opts.spriteCli ?? defaultSpriteCli
  const fetchHealthz = opts.fetchHealthz ?? defaultFetchHealthz
  const fetchSpriteUrl = opts.fetchSpriteUrl ?? defaultFetchSpriteUrl
  const resolveHarnessEnv = opts.resolveHarnessEnv ?? defaultResolveHarnessEnv
  const healthzTimeoutMs = opts.healthzTimeoutMs ?? 60_000
  const pollIntervalMs = opts.healthzPollIntervalMs ?? 2_000

  const manifestPath = resolveManifestPath(opts.golden.manifestUri, repoRoot)

  // Step 1: apply golden (apt + npm + bundle + fs + version stamp).
  // This subprocess is the same path operators use; idempotent.
  console.log(`[bootstrap] ${spriteName}: applying golden ${opts.golden.version}…`)
  {
    const r = runApplyGolden({
      spriteName,
      version: opts.golden.version,
      manifestPath,
      repoRoot,
    })
    if (r.status !== 0) {
      throw new BootstrapError('apply-golden', `exit ${r.status}: ${r.stderr ?? ''}`)
    }
  }

  // Step 2: kill any existing harness session, then boot fresh. First-run
  // bootstrap won't find one; re-runs (after partial failures) will.
  console.log(`[bootstrap] ${spriteName}: (re)starting harness…`)
  {
    const list = spriteCli(['sessions', 'list', '-s', spriteName])
    if (list.status !== 0) {
      throw new BootstrapError(
        'sessions-list',
        `exit ${list.status}: ${list.stderr ?? ''}`,
      )
    }
    for (const line of (list.stdout ?? '').split('\n')) {
      const m = /^(\d+)\s+bun\s+\/home\/sprite\/pi-h/.exec(line)
      if (m) {
        const kill = spriteCli(['sessions', 'kill', '-s', spriteName, m[1]!])
        if (kill.status !== 0) {
          // Non-fatal — log and continue. The new exec will surface a
          // real failure if the kill actually mattered.
          console.warn(
            `[bootstrap] ${spriteName}: kill session ${m[1]} returned ${kill.status} (continuing)`,
          )
        }
      }
    }

    const env = envToFlag(resolveHarnessEnv())
    // We expect this to time out — the harness keeps running in a
    // detached TTY. status 0 means harness exited immediately, which is
    // a startup-error signal.
    const start = spriteCli([
      'exec',
      '-s',
      spriteName,
      '--env',
      env,
      '--tty',
      'bun',
      '/home/sprite/pi-harness.js',
    ])
    if (start.status === 0) {
      throw new BootstrapError(
        'harness-start',
        `harness exited cleanly during boot — likely env or startup error: ${start.stderr ?? start.stdout ?? ''}`,
      )
    }
  }

  // Step 3: flip URL to auth=public so the browser can reach it. The
  // harness's JWT verification is the actual auth boundary. Idempotent.
  console.log(`[bootstrap] ${spriteName}: flipping URL to auth=public…`)
  {
    const r = spriteCli(['url', 'update', '--auth', 'public', '-s', spriteName])
    if (r.status !== 0) {
      throw new BootstrapError('url-auth', `exit ${r.status}: ${r.stderr ?? ''}`)
    }
  }

  // Step 4: verify /healthz. Poll up to healthzTimeoutMs because the
  // harness needs a few seconds to bind its port after detach.
  console.log(`[bootstrap] ${spriteName}: verifying /healthz…`)
  const url = await fetchSpriteUrl(spriteName)
  const deadline = Date.now() + healthzTimeoutMs
  let lastStatus = 0
  let lastBody = ''
  while (Date.now() < deadline) {
    try {
      const r = await fetchHealthz(`${url}/healthz`)
      lastStatus = r.status
      lastBody = r.body
      if (r.ok) {
        console.log(`[bootstrap] ${spriteName}: healthz ok (${url}/healthz)`)
        return
      }
    } catch (err) {
      lastBody = (err as Error).message
    }
    await new Promise((res) => setTimeout(res, pollIntervalMs))
  }
  throw new BootstrapError(
    'healthz',
    `did not respond OK within ${healthzTimeoutMs}ms (last status=${lastStatus}, body=${lastBody.slice(0, 200)})`,
  )
}

export { BootstrapError }
