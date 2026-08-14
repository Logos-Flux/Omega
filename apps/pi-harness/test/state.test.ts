// State module — /workspace/state.json read/write/patch. Uses an isolated
// temp WORKSPACE_ROOT set before the module is imported (the module reads
// the env var lazily, but we set it up-front to mirror the other harness
// route/IO tests).

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK_ROOT = mkdtempSync(join(tmpdir(), 'pi-harness-state-'))
process.env.WORKSPACE_ROOT = WORK_ROOT

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'

const STATE_PATH = join(WORK_ROOT, 'state.json')

const { readState, readStateSync, writeState, patchState, DEFAULT_STATE } =
  await import('../src/state')

afterEach(async () => {
  if (existsSync(STATE_PATH)) await rm(STATE_PATH)
})

describe('readState', () => {
  test('returns defaults when the file is missing', async () => {
    expect(await readState()).toEqual(DEFAULT_STATE)
  })

  test('returns defaults on malformed JSON without throwing', async () => {
    await writeFile(STATE_PATH, '{ not json', 'utf8')
    expect(await readState()).toEqual(DEFAULT_STATE)
  })

  test('fills missing fields with defaults (legacy file with only activePersona)', async () => {
    await writeFile(STATE_PATH, JSON.stringify({ activePersona: 'coder' }), 'utf8')
    const s = await readState()
    expect(s.activePersona).toBe('coder')
    expect(s.disabledSkills).toEqual([])
  })

  test('drops non-string entries from disabledSkills', async () => {
    await writeFile(
      STATE_PATH,
      JSON.stringify({ disabledSkills: ['ocr', 3, null, 'summarize'] }),
      'utf8',
    )
    expect((await readState()).disabledSkills).toEqual(['ocr', 'summarize'])
  })
})

describe('readStateSync', () => {
  test('matches readState for a written file', async () => {
    await writeState({ activePersona: 'researcher', disabledSkills: ['ocr'] })
    expect(readStateSync()).toEqual({ activePersona: 'researcher', disabledSkills: ['ocr'] })
  })

  test('returns defaults when missing', () => {
    expect(readStateSync()).toEqual(DEFAULT_STATE)
  })
})

describe('writeState / patchState', () => {
  test('writeState round-trips', async () => {
    await writeState({ activePersona: 'concise', disabledSkills: ['pdf-extract'] })
    expect(await readState()).toEqual({ activePersona: 'concise', disabledSkills: ['pdf-extract'] })
  })

  test('patchState merges over existing fields, leaving others intact', async () => {
    await writeState({ activePersona: 'coder', disabledSkills: ['ocr'] })
    const next = await patchState({ disabledSkills: [] })
    expect(next).toEqual({ activePersona: 'coder', disabledSkills: [] })
    expect(await readState()).toEqual({ activePersona: 'coder', disabledSkills: [] })
  })

  test('patchState on a missing file starts from defaults', async () => {
    const next = await patchState({ activePersona: 'researcher' })
    expect(next).toEqual({ activePersona: 'researcher', disabledSkills: [] })
  })
})
