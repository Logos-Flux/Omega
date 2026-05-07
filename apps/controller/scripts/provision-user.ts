// bun scripts/provision-user.ts <email>
//
// One-shot operator workflow to provision a per-user sprite for `email`,
// apply the latest golden for the user's release_channel, boot the
// harness, and flip the URL to auth=public.
//
// After this completes, the user's first POST /api/session/start will
// find the existing sprite (freshlyProvisioned=false) and stamp the
// pi.containers row normally. No data migration is performed — that's
// the explicit fresh-start model (see SPRITE-VERSIONING.md step 8).
//
// Idempotent at the sprite-existence level: if the sprite already exists
// the script will still re-apply the manifest, restart the harness, and
// confirm auth=public. Safe to re-run.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adminCall, controllerUrl, die } from './lib'

interface User { id: string; email: string; release_channel: string }
interface UserList { users: User[] }
interface Golden { version: string }

interface SpriteRecord {
  id: string
  name: string
  status: string
  url: string
  url_settings?: { auth: string }
}

const SPRITES_API = 'https://api.sprites.dev/v1'

const [email] = process.argv.slice(2)
if (!email) die('usage: bun scripts/provision-user.ts <email>')

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

// Operator config — set in your shell or via a sourced .env.operator file.
// Vault name has no default (operators must declare which secret store
// they're using); item titles have non-org-specific defaults that you can
// override per deployment.
const VAULT = process.env.PASS_VAULT_NAME
if (!VAULT) die('PASS_VAULT_NAME env var is required (your pass-cli vault name).')

const ITEM_SPRITES_TOKEN           = process.env.PASS_ITEM_SPRITES_TOKEN           ?? 'Sprites — API token'
const ITEM_HARNESS_JWT_SECRET      = process.env.PASS_ITEM_HARNESS_JWT_SECRET      ?? 'HARNESS_JWT_SECRET'
const ITEM_CONTROLLER_SVC_TOKEN    = process.env.PASS_ITEM_CONTROLLER_SVC_TOKEN    ?? 'Controller — service token'
const ITEM_GOOGLE_OAUTH_CONNECTORS = process.env.PASS_ITEM_GOOGLE_OAUTH_CONNECTORS ?? 'Google OAuth — connectors'
const ITEM_ANTHROPIC               = process.env.PASS_ITEM_ANTHROPIC               ?? 'Claude API'
const ITEM_GOOGLE_AI               = process.env.PASS_ITEM_GOOGLE_AI               ?? 'Gemini API'
const ITEM_PERPLEXITY              = process.env.PASS_ITEM_PERPLEXITY              ?? 'Perplexity API'

function passField(title: string, field: string): string {
  const r = spawnSync('pass-cli', ['item', 'view', '--vault-name', VAULT!, '--item-title', title, '--field', field], { encoding: 'utf8' })
  if (r.status !== 0) die(`pass-cli failed: ${title} / ${field}`)
  return r.stdout.replace(/\n$/, '')
}

// Prefer env vars where they're conventionally set; fall through to pass-cli.
function envOrPass(envVar: string, title: string, field: string): string {
  return process.env[envVar] ?? passField(title, field)
}

const SPRITES_TOKEN = envOrPass('SPRITES_API_TOKEN', ITEM_SPRITES_TOKEN, 'password')

async function spritesApi(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${SPRITES_TOKEN}`)
  headers.set('accept', 'application/json')
  return fetch(`${SPRITES_API}${path}`, { ...init, headers })
}

function spriteNameForUser(userId: string): string {
  const slug = userId.replace(/-/g, '').slice(0, 12)
  return `harness-${slug}`
}

// 1. Resolve user
console.log(`[provision] looking up ${email}…`)
const list = await adminCall<UserList>('/api/admin/users?limit=200')
const user = list.users.find((u) => u.email === email)
if (!user) die(`no user with email ${email}`)
console.log(`  user_id = ${user.id}`)
console.log(`  channel = ${user.release_channel}`)

// 2. Resolve channel's latest golden via admin /golden listing
const goldens = await adminCall<{ goldens: { version: string; manifest_uri: string; released_to: string[]; retired_at: string | null }[] }>(
  '/api/admin/golden',
)
const eligible = goldens.goldens.filter((g) => !g.retired_at && g.released_to.includes(user.release_channel))
if (eligible.length === 0) die(`no goldens released to channel ${user.release_channel}`)
// Goldens come back ordered by built_at DESC from the API.
const golden = eligible[0]!
const goldenManifest = (() => {
  if (golden.manifest_uri.startsWith('file://')) {
    return join(repoRoot, golden.manifest_uri.slice('file://'.length))
  }
  die(`unsupported manifest_uri scheme: ${golden.manifest_uri}`)
})()
console.log(`  golden  = ${golden.version}  (${golden.manifest_uri})`)

// 3. Sprite — create or fetch existing
const spriteName = spriteNameForUser(user.id)
console.log(`[provision] sprite name = ${spriteName}`)

let sprite: SpriteRecord
{
  const existing = await spritesApi(`/sprites/${encodeURIComponent(spriteName)}`)
  if (existing.ok) {
    sprite = (await existing.json()) as SpriteRecord
    console.log(`  exists already — status=${sprite.status}, auth=${sprite.url_settings?.auth}`)
  } else if (existing.status === 404) {
    console.log('  creating…')
    const r = await spritesApi('/sprites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: spriteName }),
    })
    if (!r.ok) die(`create failed: ${r.status} ${await r.text()}`)
    sprite = (await r.json()) as SpriteRecord
    console.log(`  created (status=${sprite.status})`)
  } else {
    die(`unexpected fetch status: ${existing.status}`)
  }
}

// 4. Apply golden manifest
console.log(`[provision] applying golden ${golden.version}…`)
{
  const r = spawnSync(
    'bun',
    [join(repoRoot, 'scripts', 'apply-golden.ts'), spriteName, golden.version, goldenManifest],
    { stdio: 'inherit', cwd: repoRoot },
  )
  if (r.status !== 0) die(`apply-golden failed (exit ${r.status})`)
}

// 5. Kill any running harness session, then boot fresh.
//    First-provision: no sessions yet, kill is no-op. Re-provision
//    (idempotent): existing harness is killed before restart.
console.log(`[provision] (re)starting harness…`)
{
  // sprite sessions list truncates the command column, so match a loose
  // prefix instead of the full "pi-harness" literal.
  const list = spawnSync('sprite', ['sessions', 'list', '-s', spriteName], { encoding: 'utf8' })
  for (const line of (list.stdout ?? '').split('\n')) {
    const m = /^(\d+)\s+bun\s+\/home\/sprite\/pi-h/.exec(line)
    if (m) {
      console.log(`  killing existing session ${m[1]}`)
      spawnSync('sprite', ['sessions', 'kill', '-s', spriteName, m[1]!], { stdio: 'inherit' })
    }
  }

  // CONTROLLER_BASE_URL + CONTROLLER_SERVICE_TOKEN + the GOOGLE_OAUTH_*
  // pair are the gccli/gdcli/gmcli boot shim's required vars (see
  // pi-harness "gccli/gdcli/gmcli boot shim" docs). Without all four the
  // shim disables itself at harness boot and the gccli skill prompts the
  // user to run `accounts add` manually — even though the controller's
  // /api/oauth/google/access-token would mint cleanly.
  //
  // Each value is read from the corresponding env var if set, falling back
  // to a pass-cli lookup against $PASS_VAULT_NAME for the configured item
  // titles (see PASS_ITEM_* constants at the top of this file).
  const env = [
    `ANTHROPIC_API_KEY=${envOrPass('ANTHROPIC_API_KEY', ITEM_ANTHROPIC, 'API Key')}`,
    `GOOGLE_API_KEY=${envOrPass('GOOGLE_API_KEY', ITEM_GOOGLE_AI, 'API Key')}`,
    `PERPLEXITY_API_KEY=${envOrPass('PERPLEXITY_API_KEY', ITEM_PERPLEXITY, 'API Key')}`,
    `HARNESS_JWT_SECRET=${envOrPass('HARNESS_JWT_SECRET', ITEM_HARNESS_JWT_SECRET, 'password')}`,
    'WORKSPACE_ROOT=/workspace',
    'PORT=8080',
    `CONTROLLER_BASE_URL=${controllerUrl()}`,
    `CONTROLLER_SERVICE_TOKEN=${envOrPass('CONTROLLER_SERVICE_TOKEN', ITEM_CONTROLLER_SVC_TOKEN, 'password')}`,
    `GOOGLE_OAUTH_CLIENT_ID=${envOrPass('GOOGLE_OAUTH_CLIENT_ID', ITEM_GOOGLE_OAUTH_CONNECTORS, 'client_id')}`,
    `GOOGLE_OAUTH_CLIENT_SECRET=${envOrPass('GOOGLE_OAUTH_CLIENT_SECRET', ITEM_GOOGLE_OAUTH_CONNECTORS, 'client_secret')}`,
  ].join(',')

  const start = spawnSync(
    'sprite',
    ['exec', '-s', spriteName, '--env', env, '--tty', 'bun', '/home/sprite/pi-harness.js'],
    { stdio: 'pipe', encoding: 'utf8', timeout: 8_000 },
  )
  // We expect the start command to TIME OUT (the harness keeps running);
  // a clean exit means the harness died immediately, which is bad.
  if (start.status === 0) {
    console.error('  harness exited 0 immediately — likely env / startup error')
    console.error(start.stdout?.toString() ?? '')
    console.error(start.stderr?.toString() ?? '')
    process.exit(2)
  }
  console.log(`  harness session detached (TTY keeps it alive after ours timed out)`)
}

// 6. Flip URL to auth=public so the browser can reach it. The harness's
//    JWT verification is the actual auth boundary.
console.log(`[provision] flipping URL to auth=public…`)
{
  const r = spawnSync('sprite', ['url', 'update', '--auth', 'public', '-s', spriteName], { stdio: 'inherit' })
  if (r.status !== 0) die('url update failed')
}

// 7. Verify
let spriteUrl = ''
console.log(`[provision] verifying healthz…`)
{
  // Refresh the sprite record so we have the post-flip URL.
  const r = await spritesApi(`/sprites/${encodeURIComponent(spriteName)}`)
  if (!r.ok) die(`fetch sprite post-flip failed: ${r.status}`)
  const fresh = (await r.json()) as SpriteRecord
  spriteUrl = fresh.url
  // Give the harness a beat to come up.
  await new Promise((res) => setTimeout(res, 4000))
  const hz = await fetch(`${spriteUrl}/healthz`)
  const body = await hz.text()
  if (!hz.ok) die(`healthz failed: ${hz.status} ${body}`)
  console.log(`  ${spriteUrl}/healthz → ${body.trim()}`)
}

// 8. Stamp pi.containers via the admin endpoint so the user's first
//    /api/session/start hits the existing-row fast path instead of
//    triggering auto-provision (which would race the operator and is
//    being kept off in pre-provisioned-only deployments). Idempotent
//    via the admin endpoint's ON CONFLICT DO UPDATE.
console.log(`[provision] stamping pi.containers row…`)
{
  await adminCall(`/api/admin/users/${user.id}/container`, {
    method: 'POST',
    body: {
      provider: 'sprites',
      container_name: spriteName,
      http_url: spriteUrl,
      base_image_version: golden.version,
    },
  })
  console.log(`  row stamped: provider=sprites name=${spriteName} version=${golden.version}`)
}

console.log()
console.log(`[provision] done.`)
console.log(`  user        ${user.email} (${user.release_channel})`)
console.log(`  sprite      ${spriteName}`)
console.log(`  url         ${spriteUrl}`)
console.log(`  golden      ${golden.version}`)
console.log()
console.log(`Next: have the user reload the chat surface — the controller's`)
console.log(`/api/session/start will see the existing row + sprite and return`)
console.log(`the URL+token immediately (existing-row fast path).`)
