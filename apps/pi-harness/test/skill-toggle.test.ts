// #3 — flat per-user skill toggle. Verifies the two enforcement points in
// the assembler: a disabled skill is dropped from the slot-8 catalog, and
// the read_skill tool refuses to load it (so a model that remembers the
// name from history can't bypass the toggle). The skill-toggle *route*
// (persisting disabledSkills) is covered in skills-routes.test.ts.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK_ROOT = mkdtempSync(join(tmpdir(), 'pi-harness-skill-toggle-'))
process.env.WORKSPACE_ROOT = WORK_ROOT

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import type { Invocation } from '../src/types'

const { PromptAssembler } = await import('../src/assembler')
const { writeState } = await import('../src/state')

async function seedSkill(name: string, description: string): Promise<void> {
  const dir = join(WORK_ROOT, 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`,
    'utf8',
  )
}

function invocation(): Invocation {
  return {
    trigger: 'user',
    inputType: 'prompt',
    sessionId: 'sess-1',
    userId: 'u1',
    personaName: 'default',
    soulName: 'default',
    prompt: 'hi',
    provider: 'anthropic',
    model: 'snapshot-model',
    budget: {},
    policy: {},
    delivery: 'ws',
  }
}

function catalogText(messages: readonly { content: unknown }[]): string {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n')
}

beforeEach(async () => {
  for (const sub of ['skills', 'conversations']) {
    await rm(join(WORK_ROOT, sub), { recursive: true, force: true })
  }
  await rm(join(WORK_ROOT, 'state.json'), { force: true })
  await mkdir(join(WORK_ROOT, 'conversations'), { recursive: true })
  await seedSkill('skill-a', 'First skill.')
  await seedSkill('skill-b', 'Second skill.')
})

afterAll(async () => {
  if (existsSync(WORK_ROOT)) await rm(WORK_ROOT, { recursive: true, force: true })
})

describe('slot-8 catalog filter', () => {
  test('lists both skills when none are disabled', async () => {
    const payload = await PromptAssembler.build(invocation())
    const text = catalogText(payload.systemMessages)
    expect(text).toContain('skill-a')
    expect(text).toContain('skill-b')
  })

  test('drops a disabled skill from the catalog', async () => {
    await writeState({ activePersona: 'default', disabledSkills: ['skill-b'] })
    const payload = await PromptAssembler.build(invocation())
    const text = catalogText(payload.systemMessages)
    expect(text).toContain('skill-a')
    expect(text).not.toContain('skill-b')
  })
})

describe('read_skill guard', () => {
  test('refuses to load a disabled skill but still loads enabled ones', async () => {
    await writeState({ activePersona: 'default', disabledSkills: ['skill-b'] })
    const payload = await PromptAssembler.build(invocation())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const readSkill = (payload.tools as any).read_skill
    const denied = await readSkill.execute({ name: 'skill-b' }, {})
    expect(denied.error).toContain('disabled')
    const ok = await readSkill.execute({ name: 'skill-a' }, {})
    expect(ok.skill).toBe('skill-a')
    expect(ok.body).toContain('skill-a')
  })
})
