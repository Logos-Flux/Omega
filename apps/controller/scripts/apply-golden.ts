// bun scripts/apply-golden.ts <sprite-name> <version> [<manifest-path>]
//
// Runs a golden manifest's bootstrap against a target sprite. Designed
// to be the SAME path used at first-provision (fresh sprite, everything
// is missing) and at in-place update (some or all already present) —
// every step is checked-then-installed and re-running on a fully-
// current sprite is a no-op.
//
// `version` is the *label* stamped on /etc/52l/version.json. By default
// the manifest is resolved via the convention `goldens/<version>/
// manifest.json`. Pass an explicit <manifest-path> when the version
// label and manifest content are decoupled (e.g. 1.0.1-rc1 reusing
// 1.0.0's manifest verbatim).
//
// Requires: `sprite` CLI authed to the operator's org.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { die } from './lib'

interface Manifest {
  version: string
  apt_packages: { name: string; min_version?: string }[]
  npm_globals: { name: string; version: string; binary: string }[]
  harness_bundle: { path: string; remote_path: string; sha256: string }
  default_skills?: { local_path: string; remote_path: string }
  default_personas?: { local_path: string; remote_path: string }
  fs_setup: { path: string; mode: string; owner: string; comment?: string }[]
}

const [sprite, version, manifestArg] = process.argv.slice(2)
if (!sprite || !version) die('usage: bun scripts/apply-golden.ts <sprite-name> <version> [<manifest-path>]')

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const manifestPath = manifestArg
  ? (isAbsolute(manifestArg) ? manifestArg : join(process.cwd(), manifestArg))
  : join(repoRoot, 'goldens', version, 'manifest.json')
const manifestDir = dirname(manifestPath)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest

console.log(`[apply] golden ${manifest.version} → sprite ${sprite}`)

function spriteExec(cmd: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('sprite', ['exec', '-s', sprite, '--', ...cmd], { encoding: 'utf8' })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 }
}

function spriteShell(cmd: string): { stdout: string; stderr: string; status: number } {
  return spriteExec(['bash', '-c', cmd])
}

function mustShell(cmd: string, label: string): string {
  const r = spriteShell(cmd)
  if (r.status !== 0) {
    console.error(`[apply] FAIL: ${label}`)
    console.error(r.stderr || r.stdout)
    process.exit(2)
  }
  return r.stdout
}

// 1. apt packages — install only the missing ones to keep the apt step quiet
//    on already-current sprites. Re-query post-install so the printed
//    version reflects reality, not pre-install state.
console.log('[apply] apt packages…')
{
  const want = manifest.apt_packages.map((p) => p.name)
  function queryInstalled(): Map<string, string> {
    const list = mustShell(
      `dpkg-query -W -f='\${Package} \${Version}\\n' ${want.join(' ')} 2>/dev/null || true`,
      'dpkg-query',
    )
    const m = new Map<string, string>()
    for (const line of list.trim().split('\n')) {
      const [name, ver] = line.split(/\s+/)
      if (name && ver) m.set(name, ver)
    }
    return m
  }
  let installed = queryInstalled()
  const missing = want.filter((p) => !installed.has(p))
  if (missing.length === 0) {
    console.log(`  all installed: ${want.join(', ')}`)
  } else {
    console.log(`  installing: ${missing.join(', ')}`)
    mustShell(
      `sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${missing.join(' ')}`,
      'apt-get install',
    )
    installed = queryInstalled()
  }
  for (const p of manifest.apt_packages) {
    const have = installed.get(p.name) ?? '?'
    console.log(`  ${p.name.padEnd(16)} ${have}`)
  }
}

// 2. npm globals — pin to manifest version. `npm install -g pkg@version`
//    is a no-op when that exact version is already global.
//
// Pitfall on fresh sprites: `npm` lives at /.sprite/languages/node/<v>/bin/npm,
// which sudo's secure_path doesn't include. Resolve npm's absolute path
// in the user shell and invoke sudo with it explicitly.
console.log('[apply] npm globals…')
{
  const npmPathRaw = mustShell(`command -v npm`, 'locate npm').trim()
  if (!npmPathRaw) {
    console.error('[apply] FAIL: npm not found in sprite PATH')
    process.exit(2)
  }
  const npm = npmPathRaw.split('\n')[0]!.trim()
  const list = mustShell(`${npm} list -g --depth=0 --json 2>/dev/null || echo '{}'`, 'npm list -g')
  let installed: Record<string, { version?: string }> = {}
  try {
    installed = (JSON.parse(list) as { dependencies?: Record<string, { version?: string }> }).dependencies ?? {}
  } catch {
    /* empty list, treat as none installed */
  }
  // npm's actual install prefix (where -g binaries land). DO NOT derive from
  // `command -v npm` — on Sprites that resolves to /.sprite/bin/npm, which
  // is a wrapper bash script (not a symlink), so stripping `/npm` leaves
  // /.sprite/bin and the symlink we'd create below would point back at
  // itself ("/.sprite/bin/gccli -> /.sprite/bin/gccli"). `npm config get
  // prefix` returns the underlying language root (e.g.
  // /.sprite/languages/node/nvm/versions/node/v22.20.0), and <prefix>/bin
  // is where the real binaries live.
  const npmPrefix = mustShell(`${npm} config get prefix`, 'npm config get prefix').trim()

  for (const g of manifest.npm_globals) {
    const have = installed[g.name]?.version
    if (have === g.version) {
      console.log(`  ${g.name}@${g.version}  (already installed)`)
    } else {
      console.log(`  installing ${g.name}@${g.version} (was: ${have ?? 'not installed'})`)
      mustShell(`sudo ${npm} install -g --silent ${g.name}@${g.version}`, `npm install ${g.name}`)
    }
    // Symlink each connector binary into /.sprite/bin so the harness's
    // exec PATH (which only lists /.sprite/bin + the FHS dirs) can find
    // it. Without this, `gccli` etc. resolve to "command not found" inside
    // the harness even though npm installed them under <npmPrefix>/bin/.
    // Idempotent (-sf overwrites).
    mustShell(
      `sudo ln -sf ${npmPrefix}/bin/${g.binary} /.sprite/bin/${g.binary}`,
      `symlink ${g.binary} → /.sprite/bin/`,
    )
  }
}

// 3. harness bundle — only re-upload when sha differs. `sprite exec --file`
//    is the cheapest way to get bytes onto a sprite.
console.log('[apply] harness bundle…')
{
  const remote = manifest.harness_bundle.remote_path
  const r = spriteShell(`sha256sum ${remote} 2>/dev/null | awk '{print $1}'`)
  const remoteSha = r.stdout.trim()
  const wantSha = manifest.harness_bundle.sha256
  if (remoteSha === wantSha) {
    console.log(`  ${remote}  ${remoteSha.slice(0, 12)}…  (matches manifest)`)
  } else {
    console.log(`  uploading: ${remoteSha.slice(0, 12) || 'none'} → ${wantSha.slice(0, 12)}`)
    const localBundle = join(manifestDir, manifest.harness_bundle.path)
    const u = spawnSync(
      'sprite',
      ['exec', '-s', sprite, '--file', `${localBundle}:${remote}`, '--', 'true'],
      { encoding: 'utf8' },
    )
    if (u.status !== 0) {
      console.error('[apply] FAIL: bundle upload')
      console.error(u.stderr ?? u.stdout)
      process.exit(2)
    }
    // Verify
    const verify = mustShell(`sha256sum ${remote} | awk '{print $1}'`, 'verify upload')
    if (verify.trim() !== wantSha) {
      console.error(`[apply] FAIL: post-upload sha mismatch (${verify.trim()} vs ${wantSha})`)
      process.exit(2)
    }
  }
}

// 4. fs setup — chmod + chown. Both idempotent on already-correct paths.
console.log('[apply] fs setup…')
for (const f of manifest.fs_setup) {
  mustShell(`sudo chmod ${f.mode} ${f.path} && sudo chown ${f.owner} ${f.path}`, `fs ${f.path}`)
  console.log(`  ${f.path}  mode=${f.mode}  owner=${f.owner}`)
}

// 4.5. default_skills / default_personas — tar a local tree, upload, and
// extract it over the baked remote dir. Replaces the entire dir (so
// removed entries actually disappear); the user-mutable copies under
// /workspace/{skills,personas}/ are untouched. Both registries follow the
// identical baked-dir convention, so they share one installer.
function installDefaultTree(
  spec: { local_path: string; remote_path: string },
  kind: string,
): void {
  console.log(`[apply] default ${kind}…`)
  const localTree = isAbsolute(spec.local_path) ? spec.local_path : join(manifestDir, spec.local_path)
  const tarLocal = `/tmp/${kind}-${version}.tar`
  const tarRemote = `/tmp/${kind}.tar`
  const tar = spawnSync('tar', ['-cf', tarLocal, '-C', localTree, '.'], { stdio: 'inherit' })
  if (tar.status !== 0) {
    console.error(`[apply] FAIL: local tar (${kind})`)
    process.exit(2)
  }
  const up = spawnSync(
    'sprite',
    ['exec', '-s', sprite, '--file', `${tarLocal}:${tarRemote}`, '--', 'true'],
    { stdio: 'inherit' },
  )
  if (up.status !== 0) {
    console.error(`[apply] FAIL: ${kind} tar upload`)
    process.exit(2)
  }
  mustShell(
    `sudo rm -rf ${spec.remote_path} && sudo mkdir -p ${spec.remote_path} && sudo tar -xf ${tarRemote} -C ${spec.remote_path} && sudo chown -R sprite:sprite ${spec.remote_path} && sudo chmod -R a+rX ${spec.remote_path} && rm -f ${tarRemote}`,
    `${kind} extract`,
  )
  const listing = mustShell(`ls ${spec.remote_path}`, `${kind} listing`).trim()
  console.log(`  ${spec.remote_path}  ←  ${listing.replace(/\n/g, ' ')}`)
}

if (manifest.default_skills) installDefaultTree(manifest.default_skills, 'skills')
if (manifest.default_personas) installDefaultTree(manifest.default_personas, 'personas')

// 5. version stamp — last so /etc/52l/version.json reflects the version
//    only when every previous step has succeeded. Uses the CLI `version`
//    label (not manifest.version), so synthetic re-labels work — e.g.
//    1.0.1-rc1 stamps "1.0.1-rc1" even when reusing 1.0.0's manifest.
console.log('[apply] version stamp…')
{
  const stamp = JSON.stringify({
    version,
    manifest_version: manifest.version,
    applied_at: new Date().toISOString(),
  })
  mustShell(
    `sudo mkdir -p /etc/52l && echo '${stamp.replace(/'/g, "'\\''")}' | sudo tee /etc/52l/version.json > /dev/null`,
    'write version.json',
  )
  console.log(`  /etc/52l/version.json = ${stamp}`)
}

console.log(`[apply] golden ${version} fully applied to ${sprite}`)
console.log(`        next: restart the harness if the bundle changed.`)
