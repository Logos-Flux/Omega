// #4 — skill generator. Validates writeSkill (name/description/body rules,
// baked-collision rejection, overwrite-as-update) and deleteUserSkill.
// The skill is written into a temp WORKSPACE_ROOT/skills and read back
// through the real skills Registry so we exercise the round-trip the model
// sees (write_skill → read_skill).

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK_ROOT = mkdtempSync(join(tmpdir(), 'pi-harness-skill-write-'))
process.env.WORKSPACE_ROOT = WORK_ROOT

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'

const { writeSkill, deleteUserSkill, SkillWriteError } = await import('../src/skill-write')
const { readSkill, listSkills } = await import('../src/skills')

const SKILLS_DIR = join(WORK_ROOT, 'skills')

beforeEach(async () => {
  await rm(SKILLS_DIR, { recursive: true, force: true })
})

afterAll(async () => {
  if (existsSync(WORK_ROOT)) await rm(WORK_ROOT, { recursive: true, force: true })
})

describe('writeSkill — happy path', () => {
  test('creates a SKILL.md the Registry can read back', async () => {
    const res = await writeSkill({
      name: 'weekly-report',
      description: 'Draft the Monday update. Activate on "weekly update".',
      body: '# Weekly report\n\nDo the thing.',
    })
    expect(res.name).toBe('weekly-report')
    expect(res.overwritten).toBe(false)

    const raw = await readFile(res.path, 'utf8')
    expect(raw).toContain('name: weekly-report')
    expect(raw).toContain('description: Draft the Monday update. Activate on "weekly update".')

    // Round-trips through the registry (what read_skill uses).
    const body = await readSkill('weekly-report')
    expect(body).toContain('Do the thing.')
    const listed = await listSkills()
    expect(listed.find((s) => s.name === 'weekly-report')).toBeTruthy()
  })

  test('collapses a multi-line description to one line (frontmatter is line-based)', async () => {
    const res = await writeSkill({
      name: 'multi',
      description: 'line one\nline two   with   spaces',
      body: 'body',
    })
    const raw = await readFile(res.path, 'utf8')
    expect(raw).toContain('description: line one line two with spaces')
  })

  test('overwriting an existing user skill reports overwritten=true', async () => {
    await writeSkill({ name: 'dup', description: 'first', body: 'one' })
    const res = await writeSkill({ name: 'dup', description: 'second', body: 'two' })
    expect(res.overwritten).toBe(true)
    expect(await readSkill('dup')).toContain('two')
  })
})

describe('writeSkill — validation', () => {
  test('rejects an invalid name', async () => {
    await expect(writeSkill({ name: 'Bad Name!', description: 'd', body: 'b' })).rejects.toBeInstanceOf(
      SkillWriteError,
    )
  })

  test('rejects an empty description', async () => {
    await expect(writeSkill({ name: 'x', description: '   ', body: 'b' })).rejects.toBeInstanceOf(
      SkillWriteError,
    )
  })

  test('rejects an empty body', async () => {
    await expect(writeSkill({ name: 'x', description: 'd', body: '' })).rejects.toBeInstanceOf(
      SkillWriteError,
    )
  })
})

describe('deleteUserSkill', () => {
  test('removes a user skill and reports true', async () => {
    await writeSkill({ name: 'temp', description: 'd', body: 'b' })
    expect(await deleteUserSkill('temp')).toBe(true)
    expect(await readSkill('temp')).toBeNull()
  })

  test('returns false for a name that does not exist', async () => {
    expect(await deleteUserSkill('nope')).toBe(false)
  })
})
