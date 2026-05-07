// bun scripts/update-user.ts <email>
//
// In-place update for an already-provisioned user. Reads the user's
// current pi.containers.base_image_version, compares against the latest
// non-retired golden for their channel, and if there's drift:
//   1. Insert a 'running' pi.update_audit row.
//   2. Run apply-golden against the user's existing sprite (idempotent
//      where state already matches; installs missing pieces otherwise).
//   3. Kill + restart the harness with the freshly-applied bundle.
//   4. Mark the audit row 'completed' and bump pi.containers.base_image_version.
// Errors at any step write a 'failed' audit row with details and exit
// non-zero; the user's sprite stays on the old version (apply-golden
// is purely additive — never destroys what's already there).
//
// /workspace stays untouched throughout — that's the entire point of
// the in-place model. memory.md, conversations, uploads, custom skills
// all survive.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adminCall, die } from './lib'

interface User { id: string; email: string; release_channel: string }
interface UserList { users: User[] }
interface UserDetail {
  user: User
  containers: { container_name: string; http_url: string | null; base_image_version: string | null; status: string }[]
}
interface Golden { version: string; manifest_uri: string; released_to: string[]; retired_at: string | null }

// Resolve a golden's manifest_uri to a local file path. Today's URIs
// look like `file://goldens/<version>/manifest.json`, scoped to the
// controller repo. Future schemes (s3://, db://) get added here.
function resolveManifest(uri: string, repoRoot: string): string {
  if (uri.startsWith('file://')) {
    const rel = uri.slice('file://'.length)
    return join(repoRoot, rel)
  }
  die(`unsupported manifest_uri scheme: ${uri}`)
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

// Operator config — set in your shell or via a sourced .env.operator file.
// See provision-user.ts for the full list of supported PASS_ITEM_* overrides.
const VAULT = process.env.PASS_VAULT_NAME
if (!VAULT) die('PASS_VAULT_NAME env var is required (your pass-cli vault name).')

const ITEM_HARNESS_JWT_SECRET = process.env.PASS_ITEM_HARNESS_JWT_SECRET ?? 'HARNESS_JWT_SECRET'
const ITEM_ANTHROPIC          = process.env.PASS_ITEM_ANTHROPIC          ?? 'Claude API'
const ITEM_GOOGLE_AI          = process.env.PASS_ITEM_GOOGLE_AI          ?? 'Gemini API'
const ITEM_PERPLEXITY         = process.env.PASS_ITEM_PERPLEXITY         ?? 'Perplexity API'

function passField(title: string, field: string): string {
  const r = spawnSync('pass-cli', ['item', 'view', '--vault-name', VAULT!, '--item-title', title, '--field', field], { encoding: 'utf8' })
  if (r.status !== 0) die(`pass-cli failed: ${title} / ${field}`)
  return r.stdout.replace(/\n$/, '')
}

// Prefer env vars where they're conventionally set; fall through to pass-cli.
function envOrPass(envVar: string, title: string, field: string): string {
  return process.env[envVar] ?? passField(title, field)
}

const [email] = process.argv.slice(2)
if (!email) die('usage: bun scripts/update-user.ts <email>')

// 1. Resolve user + their container row.
console.log(`[update] looking up ${email}…`)
const list = await adminCall<UserList>('/api/admin/users?limit=200')
const user = list.users.find((u) => u.email === email)
if (!user) die(`no user with email ${email}`)
const detail = await adminCall<UserDetail>(`/api/admin/users/${user.id}`)
const container = detail.containers[0]
if (!container) {
  die(`user ${email} has no pi.containers row — run provision-user.ts first`)
}
const fromVersion = container.base_image_version
console.log(`  channel:  ${user.release_channel}`)
console.log(`  sprite:   ${container.container_name}`)
console.log(`  current:  ${fromVersion ?? '(unknown — legacy)'}`)

// 2. Resolve target.
const goldens = await adminCall<{ goldens: Golden[] }>('/api/admin/golden')
const eligible = goldens.goldens.filter((g) => !g.retired_at && g.released_to.includes(user.release_channel))
if (eligible.length === 0) die(`no goldens released to channel ${user.release_channel}`)
const targetGolden = eligible[0]!
const target = targetGolden.version
const targetManifest = resolveManifest(targetGolden.manifest_uri, repoRoot)
console.log(`  target:   ${target}  (${targetGolden.manifest_uri})`)

if (fromVersion === target) {
  console.log(`[update] already on ${target} — nothing to do.`)
  process.exit(0)
}

// 3. Apply.
console.log(`[update] running apply-golden ${target}…`)
let applyOk = false
try {
  const r = spawnSync(
    'bun',
    [join(repoRoot, 'scripts', 'apply-golden.ts'), container.container_name, target, targetManifest],
    { stdio: 'inherit', cwd: repoRoot },
  )
  applyOk = r.status === 0
  if (!applyOk) {
    console.error(`[update] apply-golden exited ${r.status}`)
  }
} catch (err) {
  console.error(`[update] apply-golden threw:`, err)
}

if (!applyOk) {
  await adminCall(`/api/admin/users/${user.id}/applied`, {
    method: 'POST',
    body: { from_version: fromVersion, to_version: target, status: 'failed', error: 'apply-golden non-zero exit' },
  })
  process.exit(2)
}

// 4. Restart harness — same dance as provision-user.ts. Bundle may have
//    changed during apply, so the running harness needs to pick it up.
console.log(`[update] restarting harness…`)
{
  const sessionsList = spawnSync('sprite', ['sessions', 'list', '-s', container.container_name], { encoding: 'utf8' })
  // sprite sessions list truncates the command column, so match a loose
  // prefix instead of the full "pi-harness" literal.
  for (const line of (sessionsList.stdout ?? '').split('\n')) {
    const m = /^(\d+)\s+bun\s+\/home\/sprite\/pi-h/.exec(line)
    if (m) spawnSync('sprite', ['sessions', 'kill', '-s', container.container_name, m[1]!], { stdio: 'inherit' })
  }
  const env = [
    `ANTHROPIC_API_KEY=${envOrPass('ANTHROPIC_API_KEY', ITEM_ANTHROPIC, 'API Key')}`,
    `GOOGLE_API_KEY=${envOrPass('GOOGLE_API_KEY', ITEM_GOOGLE_AI, 'API Key')}`,
    `PERPLEXITY_API_KEY=${envOrPass('PERPLEXITY_API_KEY', ITEM_PERPLEXITY, 'API Key')}`,
    `HARNESS_JWT_SECRET=${envOrPass('HARNESS_JWT_SECRET', ITEM_HARNESS_JWT_SECRET, 'password')}`,
    'WORKSPACE_ROOT=/workspace',
    'PORT=8080',
  ].join(',')
  const start = spawnSync(
    'sprite',
    ['exec', '-s', container.container_name, '--env', env, '--tty', 'bun', '/home/sprite/pi-harness.js'],
    { stdio: 'pipe', encoding: 'utf8', timeout: 8_000 },
  )
  if (start.status === 0) {
    await adminCall(`/api/admin/users/${user.id}/applied`, {
      method: 'POST',
      body: { from_version: fromVersion, to_version: target, status: 'failed', error: 'harness exited 0 immediately' },
    })
    console.error('[update] harness exited 0 right after start — env / startup error')
    console.error(start.stdout?.toString() ?? '')
    console.error(start.stderr?.toString() ?? '')
    process.exit(2)
  }
}

// 5. Verify healthz comes back. Harness needs a few seconds to bind.
console.log(`[update] verifying healthz…`)
{
  await new Promise((res) => setTimeout(res, 4000))
  if (!container.http_url) {
    console.warn('  no http_url stored — skipping healthz check')
  } else {
    const hz = await fetch(`${container.http_url}/healthz`)
    const body = await hz.text()
    if (!hz.ok) {
      await adminCall(`/api/admin/users/${user.id}/applied`, {
        method: 'POST',
        body: { from_version: fromVersion, to_version: target, status: 'failed', error: `healthz: ${hz.status}` },
      })
      die(`healthz failed: ${hz.status} ${body}`)
    }
    console.log(`  ${container.http_url}/healthz → ${body.trim()}`)
  }
}

// 6. Mark complete.
console.log(`[update] writing audit + bumping container version…`)
const result = await adminCall<{ audit_id: string; status: string; to_version: string }>(
  `/api/admin/users/${user.id}/applied`,
  { method: 'POST', body: { from_version: fromVersion, to_version: target, status: 'completed' } },
)
console.log()
console.log(`[update] done. ${fromVersion ?? '(legacy)'} → ${target}`)
console.log(`  audit_id  ${result.audit_id}`)
