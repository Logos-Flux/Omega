// Tests for ensureWorkspace() — idempotence, layout creation, legacy
// memory.md migration, soul seeding semantics.
//
// `WORKSPACE_ROOT` is read once at module load by `src/memory.ts`, so
// we set the env var BEFORE importing anything that transitively pulls
// memory.ts. Same trick the snapshot test uses.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK_ROOT = mkdtempSync(join(tmpdir(), 'pi-harness-ws-'))
process.env.WORKSPACE_ROOT = WORK_ROOT

import { afterAll, describe, expect, test } from 'bun:test'
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'

const { ensureWorkspace } = await import('../src/workspace')

afterAll(async () => {
  await rm(WORK_ROOT, { recursive: true, force: true })
})

async function wipe(): Promise<void> {
  if (!existsSync(WORK_ROOT)) return
  for (const entry of await readdir(WORK_ROOT)) {
    await rm(join(WORK_ROOT, entry), { recursive: true, force: true })
  }
}

const EXPECTED_DIRS = [
  'personas',
  'skills',
  'quick_actions',
  'memory',
  'memory/skills',
  'sessions',
  'inbox',
  'briefs',
  'kb',
]

const EXPECTED_FILES: [string, string][] = [
  ['profile.json', '{}'],
  ['preferences.json', '{}'],
  ['state.json', '{"activePersona":"default","disabledSkills":[]}'],
  ['kb/corpora.json', '{"corpora":[]}'],
  ['audit.jsonl', ''],
  ['schedule.jsonl', ''],
  ['watchers.jsonl', ''],
]

describe('ensureWorkspace', () => {
  test('creates the full layout on a fresh workspace', async () => {
    await wipe()
    await ensureWorkspace()
    for (const dir of EXPECTED_DIRS) {
      const path = join(WORK_ROOT, dir)
      const s = await stat(path)
      expect(s.isDirectory()).toBe(true)
    }
    for (const [path, contents] of EXPECTED_FILES) {
      const full = join(WORK_ROOT, path)
      expect(existsSync(full)).toBe(true)
      const text = await readFile(full, 'utf8')
      expect(text).toBe(contents)
    }
  })

  test('is idempotent — second call is a no-op', async () => {
    await wipe()
    await ensureWorkspace()
    // Mutate a seeded file; second ensureWorkspace must NOT overwrite.
    await writeFile(
      join(WORK_ROOT, 'profile.json'),
      '{"name":"Chris"}',
      'utf8',
    )
    await writeFile(
      join(WORK_ROOT, 'state.json'),
      '{"activePersona":"dev"}',
      'utf8',
    )
    await ensureWorkspace()
    const profile = await readFile(join(WORK_ROOT, 'profile.json'), 'utf8')
    const state = await readFile(join(WORK_ROOT, 'state.json'), 'utf8')
    expect(profile).toBe('{"name":"Chris"}')
    expect(state).toBe('{"activePersona":"dev"}')
  })

  test('migrates legacy memory.md to memory/_global.md', async () => {
    await wipe()
    // Pre-create the legacy file as the old harness would have left it.
    await writeFile(
      join(WORK_ROOT, 'memory.md'),
      '## 2026-04-20\nlegacy memory body\n',
      'utf8',
    )
    await ensureWorkspace()
    expect(existsSync(join(WORK_ROOT, 'memory.md'))).toBe(false)
    const moved = await readFile(
      join(WORK_ROOT, 'memory', '_global.md'),
      'utf8',
    )
    expect(moved).toBe('## 2026-04-20\nlegacy memory body\n')
  })

  test('migration is safe to run twice', async () => {
    await wipe()
    await writeFile(join(WORK_ROOT, 'memory.md'), 'first', 'utf8')
    await ensureWorkspace()
    expect(
      await readFile(join(WORK_ROOT, 'memory', '_global.md'), 'utf8'),
    ).toBe('first')
    // Second boot must leave the migrated file alone, even if
    // somebody re-creates memory.md by accident — since the dst
    // already exists, we don't clobber it.
    await writeFile(join(WORK_ROOT, 'memory.md'), 'second', 'utf8')
    await ensureWorkspace()
    expect(
      await readFile(join(WORK_ROOT, 'memory', '_global.md'), 'utf8'),
    ).toBe('first')
  })

  test('does not migrate when target already exists', async () => {
    await wipe()
    await mkdir(join(WORK_ROOT, 'memory'), { recursive: true })
    await writeFile(
      join(WORK_ROOT, 'memory', '_global.md'),
      'user content',
      'utf8',
    )
    await writeFile(join(WORK_ROOT, 'memory.md'), 'legacy', 'utf8')
    await ensureWorkspace()
    expect(
      await readFile(join(WORK_ROOT, 'memory', '_global.md'), 'utf8'),
    ).toBe('user content')
    // Legacy file is left in place since we refuse to clobber the
    // target — operator can decide what to do with it.
    expect(existsSync(join(WORK_ROOT, 'memory.md'))).toBe(true)
  })

  test('does not overwrite existing soul.md (preserves user edits)', async () => {
    await wipe()
    await writeFile(join(WORK_ROOT, 'soul.md'), 'my custom soul', 'utf8')
    await ensureWorkspace()
    const soul = await readFile(join(WORK_ROOT, 'soul.md'), 'utf8')
    expect(soul).toBe('my custom soul')
  })
})
