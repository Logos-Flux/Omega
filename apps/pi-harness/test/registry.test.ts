// Tests for the generic Registry<T> contract — user-wins-on-collision,
// alphabetical sort, skip-on-invalid, tolerance for absent dirs.
//
// The Registry is parse-callback-driven, so tests use a tiny synthetic
// entry shape (`name: string` from a plaintext file). Real registries
// (skills, personas, etc.) get coverage indirectly via the assembler
// snapshot tests.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Registry, type RegistryEntry } from '../src/lib/registry'

interface TestEntry extends RegistryEntry {
  name: string
  source: 'user' | 'baked'
  body: string
}

const ROOT = await mkdtemp(join(tmpdir(), 'pi-harness-registry-'))
const USER_DIR = join(ROOT, 'user')
const BAKED_DIR = join(ROOT, 'baked')

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(USER_DIR, { recursive: true, force: true })
  await rm(BAKED_DIR, { recursive: true, force: true })
})

async function writeEntry(
  baseDir: string,
  _source: 'user' | 'baked',
  name: string,
  body: string,
): Promise<void> {
  // `source` is part of the call signature for self-documenting test
  // setup ("write a baked entry called foo") even though the actual
  // file write only needs the dir + name.
  const dir = join(baseDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'entry.txt'), body, 'utf8')
}

function makeRegistry(): Registry<TestEntry> {
  return new Registry<TestEntry>({
    bakedDir: BAKED_DIR,
    userDir: USER_DIR,
    parse: async (path) => {
      try {
        const file = Bun.file(join(path, 'entry.txt'))
        if (!(await file.exists())) return null
        const body = await file.text()
        if (body.startsWith('INVALID')) return null
        const name = path.split('/').filter(Boolean).pop() ?? ''
        const source = path.startsWith(USER_DIR) ? 'user' : 'baked'
        return { name, body, source }
      } catch {
        return null
      }
    },
  })
}

describe('Registry', () => {
  test('returns empty list when neither dir exists', async () => {
    const r = makeRegistry()
    expect(await r.list()).toEqual([])
    expect(await r.get('anything')).toBeNull()
  })

  test('reads entries from baked-only', async () => {
    await writeEntry(BAKED_DIR, 'baked', 'foo', 'foo body')
    await writeEntry(BAKED_DIR, 'baked', 'bar', 'bar body')
    const r = makeRegistry()
    const list = await r.list()
    expect(list.map((e) => e.name)).toEqual(['bar', 'foo'])
    expect(list.every((e) => e.source === 'baked')).toBe(true)
  })

  test('reads entries from user-only', async () => {
    await writeEntry(USER_DIR, 'user', 'alpha', 'a')
    const r = makeRegistry()
    const list = await r.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.source).toBe('user')
  })

  test('user wins on name collision', async () => {
    await writeEntry(BAKED_DIR, 'baked', 'shared', 'BAKED VERSION')
    await writeEntry(USER_DIR, 'user', 'shared', 'USER VERSION')
    const r = makeRegistry()
    const list = await r.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.source).toBe('user')
    expect(list[0]!.body).toBe('USER VERSION')
  })

  test('alphabetical sort across both sources', async () => {
    await writeEntry(BAKED_DIR, 'baked', 'charlie', '')
    await writeEntry(BAKED_DIR, 'baked', 'alpha', '')
    await writeEntry(USER_DIR, 'user', 'bravo', '')
    const r = makeRegistry()
    const list = await r.list()
    expect(list.map((e) => e.name)).toEqual(['alpha', 'bravo', 'charlie'])
  })

  test('skips entries whose parse returns null', async () => {
    await writeEntry(BAKED_DIR, 'baked', 'good', 'ok')
    await writeEntry(BAKED_DIR, 'baked', 'broken', 'INVALID — should skip')
    const r = makeRegistry()
    const list = await r.list()
    expect(list.map((e) => e.name)).toEqual(['good'])
  })

  test('reload() invalidates the cache', async () => {
    await writeEntry(BAKED_DIR, 'baked', 'one', '1')
    const r = makeRegistry()
    expect(await r.list()).toHaveLength(1)
    await writeEntry(BAKED_DIR, 'baked', 'two', '2')
    // Stale cache returns the old set.
    expect(await r.list()).toHaveLength(1)
    r.reload()
    expect(await r.list()).toHaveLength(2)
  })

  test('only one dir present is fine', async () => {
    await writeEntry(USER_DIR, 'user', 'lonely', '')
    const r = makeRegistry()
    expect(await r.list()).toHaveLength(1)
  })

  test('get() honours user-wins', async () => {
    await writeEntry(BAKED_DIR, 'baked', 'shared', 'baked')
    await writeEntry(USER_DIR, 'user', 'shared', 'user')
    const r = makeRegistry()
    const entry = await r.get('shared')
    expect(entry?.source).toBe('user')
  })

  test('get() returns null for unknown', async () => {
    await writeEntry(BAKED_DIR, 'baked', 'real', '')
    const r = makeRegistry()
    expect(await r.get('imaginary')).toBeNull()
  })
})
