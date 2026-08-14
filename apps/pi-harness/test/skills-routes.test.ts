// Skill HTTP routes — list (with enabled flags), read body, toggle on/off.
// Isolated temp WORKSPACE_ROOT set before importing the route module.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK_ROOT = mkdtempSync(join(tmpdir(), 'pi-harness-skills-routes-'))
process.env.WORKSPACE_ROOT = WORK_ROOT

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'

const { handleSkillRoute } = await import('../src/skills-routes')
const { readState } = await import('../src/state')

async function seedSkill(name: string, description: string): Promise<void> {
  const dir = join(WORK_ROOT, 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody text.\n`,
    'utf8',
  )
}

function makeRequest(method: string, path: string, body?: unknown): Request {
  const url = `http://harness.local${path}`
  if (body === undefined) return new Request(url, { method })
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  await rm(join(WORK_ROOT, 'skills'), { recursive: true, force: true })
  await rm(join(WORK_ROOT, 'state.json'), { force: true })
  await seedSkill('alpha', 'The alpha skill.')
  await seedSkill('beta', 'The beta skill.')
})

afterAll(async () => {
  if (existsSync(WORK_ROOT)) await rm(WORK_ROOT, { recursive: true, force: true })
})

describe('GET /skills', () => {
  test('lists skills with enabled=true and source=user by default', async () => {
    const r = await handleSkillRoute(makeRequest('GET', '/skills'))
    expect(r?.status).toBe(200)
    const body = r?.body as { skills: { name: string; enabled: boolean; source: string }[] }
    const byName = Object.fromEntries(body.skills.map((s) => [s.name, s.enabled]))
    expect(byName).toEqual({ alpha: true, beta: true })
    // Seeded under WORKSPACE_ROOT/skills ⇒ user-sourced (deletable).
    expect(body.skills.every((s) => s.source === 'user')).toBe(true)
  })

  test('reflects a disabled skill as enabled=false', async () => {
    await handleSkillRoute(makeRequest('PUT', '/skills/beta', { enabled: false }))
    const r = await handleSkillRoute(makeRequest('GET', '/skills'))
    const body = r?.body as { skills: { name: string; enabled: boolean }[] }
    expect(body.skills.find((s) => s.name === 'beta')?.enabled).toBe(false)
    expect(body.skills.find((s) => s.name === 'alpha')?.enabled).toBe(true)
  })

  test('?validate includes the issues array', async () => {
    const r = await handleSkillRoute(makeRequest('GET', '/skills?validate=1'))
    expect(r?.body).toHaveProperty('issues')
  })
})

describe('GET /skills/:name', () => {
  test('returns the body for a known skill', async () => {
    const r = await handleSkillRoute(makeRequest('GET', '/skills/alpha'))
    expect(r?.status).toBe(200)
    expect((r?.body as { body: string }).body).toContain('alpha')
  })

  test('404 for an unknown skill', async () => {
    const r = await handleSkillRoute(makeRequest('GET', '/skills/missing'))
    expect(r?.status).toBe(404)
  })
})

describe('PUT /skills/:name', () => {
  test('disabling persists to state.json::disabledSkills', async () => {
    const r = await handleSkillRoute(makeRequest('PUT', '/skills/beta', { enabled: false }))
    expect(r?.status).toBe(200)
    expect((await readState()).disabledSkills).toEqual(['beta'])
  })

  test('re-enabling removes it from disabledSkills', async () => {
    await handleSkillRoute(makeRequest('PUT', '/skills/beta', { enabled: false }))
    await handleSkillRoute(makeRequest('PUT', '/skills/beta', { enabled: true }))
    expect((await readState()).disabledSkills).toEqual([])
  })

  test('400 on a non-boolean body', async () => {
    const r = await handleSkillRoute(makeRequest('PUT', '/skills/beta', { enabled: 'no' }))
    expect(r?.status).toBe(400)
  })

  test('404 when toggling an unknown skill', async () => {
    const r = await handleSkillRoute(makeRequest('PUT', '/skills/ghost', { enabled: false }))
    expect(r?.status).toBe(404)
  })
})

describe('DELETE /skills/:name', () => {
  test('deletes a user skill', async () => {
    const r = await handleSkillRoute(makeRequest('DELETE', '/skills/beta'))
    expect(r?.status).toBe(200)
    const after = await handleSkillRoute(makeRequest('GET', '/skills/beta'))
    expect(after?.status).toBe(404)
  })

  test('clears a deleted skill from disabledSkills', async () => {
    await handleSkillRoute(makeRequest('PUT', '/skills/beta', { enabled: false }))
    await handleSkillRoute(makeRequest('DELETE', '/skills/beta'))
    expect((await readState()).disabledSkills).toEqual([])
  })

  test('404 for an unknown skill', async () => {
    const r = await handleSkillRoute(makeRequest('DELETE', '/skills/ghost'))
    expect(r?.status).toBe(404)
  })
})

describe('non-skill routes', () => {
  test('returns null so the caller falls through', async () => {
    expect(await handleSkillRoute(makeRequest('GET', '/profile'))).toBeNull()
  })
})
