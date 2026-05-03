// Workspace boot — runs once on harness startup, idempotent on every
// subsequent run. Materialises the full /workspace storage layout from
// AGENT_ARCHITECTURE.md L305-356 so every sub-system (registries,
// memory, sessions, audit) can assume its directories and inert files
// exist. Roadmap I.C.1.
//
// Idempotence rules:
//   - Directories are created with `recursive: true`. Already exists =
//     no-op.
//   - JSON / jsonl files are only written when missing — we never
//     clobber a user's edits.
//   - One-time migrations (legacy memory.md → memory/_global.md, baked
//     soul.md → workspace soul.md) only fire when the source exists
//     and the target doesn't. Re-running on a migrated tree is a
//     no-op, by design.
//
// Tests can override the workspace root via the `WORKSPACE_ROOT` env
// var (already supported by `src/memory.ts`); this module reads
// `WORKSPACE_ROOT` directly so the test that wants a temp tree can
// set it before importing.

import { existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

// Read WORKSPACE_ROOT lazily at call time rather than module load
// time. The runtime answer is identical (Bun resolves the env var
// once on first request, and the harness never mutates it after
// boot), but the test suite *does* mutate `process.env.WORKSPACE_ROOT`
// between test files — and Bun's module graph is shared across
// workers in a single `bun test` invocation, so a frozen value
// captured at import time would point at whichever test file loaded
// memory.ts first. Reading at call time keeps each test's chosen
// root authoritative.
function workspaceRoot(): string {
  return process.env.WORKSPACE_ROOT ?? '/workspace'
}

const DEFAULT_STATE = JSON.stringify({ activePersona: 'default' })
const DEFAULT_CORPORA = JSON.stringify({ corpora: [] })
const BAKED_SOUL_PATH = '/home/sprite/soul.md'

/**
 * Directories that must exist after `ensureWorkspace()` returns. Order
 * is irrelevant since each is created independently with
 * `recursive: true`.
 */
function workspaceDirs(root: string): string[] {
  return [
    root,
    join(root, 'personas'),
    join(root, 'skills'),
    join(root, 'quick_actions'),
    join(root, 'memory'),
    join(root, 'memory', 'skills'),
    join(root, 'sessions'),
    // Legacy. The pre-refactor harness wrote conversation files to
    // /workspace/conversations/. New canonical home is
    // /workspace/sessions/<sid>/conversation.jsonl, but we keep the
    // legacy dir alive so already-running sprites see a smooth
    // transition; cutover happens in Phase III when the controller
    // starts minting session ids that route through the new shape.
    join(root, 'conversations'),
    join(root, 'inbox'),
    join(root, 'briefs'),
    join(root, 'kb'),
  ]
}

/**
 * Initial-content files. `[path, contents]`. Only written when the
 * file is missing — never overwritten. Empty files (audit, schedule,
 * watchers jsonl) are also created here.
 */
function workspaceSeeds(root: string): [string, string][] {
  return [
    [join(root, 'profile.json'), '{}'],
    [join(root, 'preferences.json'), '{}'],
    [join(root, 'state.json'), DEFAULT_STATE],
    [join(root, 'kb', 'corpora.json'), DEFAULT_CORPORA],
    [join(root, 'audit.jsonl'), ''],
    [join(root, 'schedule.jsonl'), ''],
    [join(root, 'watchers.jsonl'), ''],
  ]
}

async function ensureDir(path: string): Promise<void> {
  if (existsSync(path)) return
  await mkdir(path, { recursive: true })
}

async function writeIfMissing(path: string, contents: string): Promise<void> {
  if (existsSync(path)) return
  await writeFile(path, contents, 'utf8')
}

/**
 * One-time migration: legacy `/workspace/memory.md` becomes the
 * canonical `/workspace/memory/_global.md`. Move (not copy) so the
 * legacy path is retired the first time a new harness boots on an
 * old workspace. Safe on re-runs because the source no longer exists
 * after the first migration.
 */
async function migrateLegacyMemory(root: string): Promise<void> {
  const src = join(root, 'memory.md')
  const dst = join(root, 'memory', '_global.md')
  if (!existsSync(src)) return
  if (existsSync(dst)) return
  // memory/ was already created above as part of workspaceDirs().
  await rename(src, dst)
}

/**
 * One-time copy: golden soul (`/home/sprite/soul.md`) → user soul
 * (`/workspace/soul.md`) when the user copy is absent. Subsequent
 * boots are no-ops, which preserves any edits the user makes after
 * the first boot — including deleting the soul file (we don't
 * resurrect it).
 */
async function seedUserSoul(root: string): Promise<void> {
  const dst = join(root, 'soul.md')
  if (existsSync(dst)) return
  if (!existsSync(BAKED_SOUL_PATH)) return
  try {
    const s = await stat(BAKED_SOUL_PATH)
    if (!s.isFile()) return
  } catch {
    return
  }
  await copyFile(BAKED_SOUL_PATH, dst)
}

export async function ensureWorkspace(): Promise<void> {
  const root = workspaceRoot()
  for (const dir of workspaceDirs(root)) {
    await ensureDir(dir)
  }
  // Migrations before seeds: legacy memory.md must move before
  // anything inspects memory/_global.md, and the soul copy must run
  // before the SoulRegistry is consulted on first request.
  await migrateLegacyMemory(root)
  await seedUserSoul(root)
  for (const [path, contents] of workspaceSeeds(root)) {
    await writeIfMissing(path, contents)
  }
}
