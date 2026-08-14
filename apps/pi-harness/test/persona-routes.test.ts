// Persona HTTP routes (#6) — list presets + switch the active persona.
// Personas are seeded as user personas under WORKSPACE_ROOT/personas so the
// test doesn't depend on a baked /home/sprite/personas tree.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK_ROOT = mkdtempSync(join(tmpdir(), 'pi-harness-persona-routes-'))
process.env.WORKSPACE_ROOT = WORK_ROOT

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'

const { handlePersonaRoute } = await import('../src/persona-routes')
const { readState } = await import('../src/state')

async function seedPersona(name: string, body: string): Promise<void> {
  const dir = join(WORK_ROOT, 'personas', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'persona.md'), `---\nname: ${name}\n---\n\n${body}\n`, 'utf8')
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
  await rm(join(WORK_ROOT, 'personas'), { recursive: true, force: true })
  await rm(join(WORK_ROOT, 'state.json'), { force: true })
  await seedPersona('default', '')
  await seedPersona('concise', 'You are in **Concise** mode. Answer briefly.')
})

afterAll(async () => {
  if (existsSync(WORK_ROOT)) await rm(WORK_ROOT, { recursive: true, force: true })
})

describe('GET /personas', () => {
  test('lists personas with labels and the active default', async () => {
    const r = await handlePersonaRoute(makeRequest('GET', '/personas'))
    expect(r?.status).toBe(200)
    const body = r?.body as { personas: { name: string; label: string }[]; active: string }
    expect(body.active).toBe('default')
    const byName = Object.fromEntries(body.personas.map((p) => [p.name, p.label]))
    // Empty-body persona falls back to a title-cased name.
    expect(byName.default).toBe('Default')
    // Non-empty body → first line, markdown emphasis stripped.
    expect(byName.concise).toBe('You are in Concise mode. Answer briefly.')
  })
})

describe('PUT /persona', () => {
  test('switches the active persona and persists it', async () => {
    const r = await handlePersonaRoute(makeRequest('PUT', '/persona', { name: 'concise' }))
    expect(r?.status).toBe(200)
    expect((r?.body as { active: string }).active).toBe('concise')
    expect((await readState()).activePersona).toBe('concise')

    const list = await handlePersonaRoute(makeRequest('GET', '/personas'))
    expect((list?.body as { active: string }).active).toBe('concise')
  })

  test('404 for an unknown persona (and leaves the active one unchanged)', async () => {
    const r = await handlePersonaRoute(makeRequest('PUT', '/persona', { name: 'nope' }))
    expect(r?.status).toBe(404)
    expect((await readState()).activePersona).toBe('default')
  })

  test('400 when name is missing', async () => {
    const r = await handlePersonaRoute(makeRequest('PUT', '/persona', {}))
    expect(r?.status).toBe(400)
  })
})

describe('non-persona routes', () => {
  test('returns null so the caller falls through', async () => {
    expect(await handlePersonaRoute(makeRequest('GET', '/profile'))).toBeNull()
  })
})
