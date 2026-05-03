// Tests for the profile HTTP route handlers (Phase II.A.2).
//
// We test the route layer in isolation by importing
// `handleProfileRoute` and feeding it Request objects. This bypasses
// `src/index.ts` (which boots Bun.serve at module load) so each test
// can use its own temp WORKSPACE_ROOT without process-level
// orchestration.
//
// JWT auth is the index.ts caller's responsibility — these tests
// assume the route is invoked post-verification, which matches how
// index.ts wires it.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK_ROOT = mkdtempSync(join(tmpdir(), 'pi-harness-profile-routes-'))
process.env.WORKSPACE_ROOT = WORK_ROOT

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'

const { handleProfileRoute } = await import('../src/profile-routes')
const {
  proposeProfileChange,
  readProfile,
  writeProfile,
  listProfileProposals,
} = await import('../src/profile')

const PROFILE_PATH = join(WORK_ROOT, 'profile.json')
const PROPOSALS_PATH = join(WORK_ROOT, 'profile.proposals.json')

afterAll(async () => {
  await rm(WORK_ROOT, { recursive: true, force: true })
})

beforeEach(async () => {
  if (existsSync(PROFILE_PATH)) await rm(PROFILE_PATH)
  if (existsSync(PROPOSALS_PATH)) await rm(PROPOSALS_PATH)
})

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
): Request {
  const url = `http://harness.local${path}`
  if (body === undefined) {
    return new Request(url, { method })
  }
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('GET /profile', () => {
  test('returns the empty profile when file is missing', async () => {
    const result = await handleProfileRoute(makeRequest('GET', '/profile'))
    expect(result).not.toBeNull()
    expect(result!.status).toBe(200)
    expect(result!.body).toEqual({ profile: {} })
  })

  test('returns the persisted profile', async () => {
    await writeProfile({ name: 'Ada Lovelace', preferred_name: 'Ada' })
    const result = await handleProfileRoute(makeRequest('GET', '/profile'))
    expect(result!.status).toBe(200)
    expect(result!.body).toEqual({
      profile: { name: 'Ada Lovelace', preferred_name: 'Ada' },
    })
  })
})

describe('PUT /profile', () => {
  test('happy path: writes the profile and returns ok', async () => {
    const result = await handleProfileRoute(
      makeRequest('PUT', '/profile', {
        profile: { name: 'Ada Lovelace', personal: { location: 'London, UK' } },
      }),
    )
    expect(result!.status).toBe(200)
    expect(result!.body).toEqual({ ok: true })

    expect(await readProfile()).toEqual({
      name: 'Ada Lovelace',
      personal: { location: 'London, UK' },
    })
  })

  test('400 on schema violation', async () => {
    const result = await handleProfileRoute(
      makeRequest('PUT', '/profile', {
        profile: { communication: { tone_default: 'snarky' } },
      }),
    )
    expect(result!.status).toBe(400)
    const body = result!.body as { error: string }
    expect(body.error).toContain('communication.tone_default')
  })

  test('400 on missing profile wrapper', async () => {
    const result = await handleProfileRoute(
      makeRequest('PUT', '/profile', { name: 'Ada' }),
    )
    expect(result!.status).toBe(400)
    expect(result!.body).toEqual({ error: 'expected { profile: ... }' })
  })

  test('400 on invalid JSON', async () => {
    const req = new Request('http://harness.local/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not json',
    })
    const result = await handleProfileRoute(req)
    expect(result!.status).toBe(400)
    expect(result!.body).toEqual({ error: 'invalid json' })
  })

  test('400 on unknown top-level field (strict schema)', async () => {
    const result = await handleProfileRoute(
      makeRequest('PUT', '/profile', {
        profile: { name: 'Ada', mystery: 'value' },
      }),
    )
    expect(result!.status).toBe(400)
  })
})

describe('GET /profile/proposals', () => {
  test('returns empty list initially', async () => {
    const result = await handleProfileRoute(
      makeRequest('GET', '/profile/proposals'),
    )
    expect(result!.status).toBe(200)
    expect(result!.body).toEqual({ proposals: [] })
  })

  test('returns queued proposals', async () => {
    await proposeProfileChange('preferred_name', 'Ada', 'agent')
    await proposeProfileChange('personal.location', 'London, UK', 'agent')

    const result = await handleProfileRoute(
      makeRequest('GET', '/profile/proposals'),
    )
    expect(result!.status).toBe(200)
    const body = result!.body as { proposals: { field: string }[] }
    expect(body.proposals).toHaveLength(2)
    expect(body.proposals.map((p) => p.field)).toEqual([
      'preferred_name',
      'personal.location',
    ])
  })
})

describe('POST /profile/proposals/:id/accept', () => {
  test('happy path: applies and removes from queue', async () => {
    const { proposalId } = await proposeProfileChange(
      'personal.location',
      'London, UK',
      'agent',
    )

    const result = await handleProfileRoute(
      makeRequest('POST', `/profile/proposals/${proposalId}/accept`),
    )
    expect(result!.status).toBe(200)
    expect(result!.body).toEqual({ ok: true })

    expect(await readProfile()).toEqual({
      personal: { location: 'London, UK' },
    })
    expect(await listProfileProposals()).toEqual([])
  })

  test('404 on unknown proposal id', async () => {
    const result = await handleProfileRoute(
      makeRequest(
        'POST',
        '/profile/proposals/00000000-0000-0000-0000-000000000000/accept',
      ),
    )
    expect(result!.status).toBe(404)
    const body = result!.body as { error: string }
    expect(body.error).toContain('not found')
  })
})

describe('POST /profile/proposals/:id/reject', () => {
  test('happy path: drops without touching profile.json', async () => {
    await writeProfile({ name: 'Ada Lovelace' })
    const { proposalId } = await proposeProfileChange(
      'personal.location',
      'London, UK',
      'agent',
    )

    const result = await handleProfileRoute(
      makeRequest('POST', `/profile/proposals/${proposalId}/reject`),
    )
    expect(result!.status).toBe(200)
    expect(result!.body).toEqual({ ok: true })

    expect(await readProfile()).toEqual({ name: 'Ada Lovelace' })
    expect(await listProfileProposals()).toEqual([])
  })

  test('404 on unknown proposal id', async () => {
    const result = await handleProfileRoute(
      makeRequest(
        'POST',
        '/profile/proposals/00000000-0000-0000-0000-000000000000/reject',
      ),
    )
    expect(result!.status).toBe(404)
  })

  test('400 on unknown action verb', async () => {
    const { proposalId } = await proposeProfileChange(
      'preferred_name',
      'Ada',
      'agent',
    )
    const result = await handleProfileRoute(
      makeRequest('POST', `/profile/proposals/${proposalId}/explode`),
    )
    expect(result!.status).toBe(400)
    const body = result!.body as { error: string }
    expect(body.error).toContain('unknown action')
  })

  test('400 when /:id segment is missing', async () => {
    const result = await handleProfileRoute(
      makeRequest('POST', '/profile/proposals/just-an-id'),
    )
    expect(result!.status).toBe(400)
  })
})

describe('non-profile paths', () => {
  test('returns null so the caller falls through', async () => {
    const result = await handleProfileRoute(
      makeRequest('GET', '/something-else'),
    )
    expect(result).toBeNull()
  })
})
