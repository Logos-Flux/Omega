// Tests for the profile module — schema validation, read/write
// primitives, and the propose/accept/reject queue.
//
// `WORKSPACE_ROOT` is read at call time inside src/profile.ts, but
// other modules (memory.ts, workspace.ts) lazy-read it too, so the
// safest pattern is to set the env var BEFORE importing anything that
// transitively pulls those modules. Mirrors test/workspace.test.ts.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK_ROOT = mkdtempSync(join(tmpdir(), 'pi-harness-profile-'))
process.env.WORKSPACE_ROOT = WORK_ROOT

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'

import type { Profile } from '../src/profile'

const {
  ProfileSchema,
  ProfileValidationError,
  acceptProfileProposal,
  listProfileProposals,
  proposeProfileChange,
  readProfile,
  rejectProfileProposal,
  writeProfile,
} = await import('../src/profile')

const PROFILE_PATH = join(WORK_ROOT, 'profile.json')
const PROPOSALS_PATH = join(WORK_ROOT, 'profile.proposals.json')

afterAll(async () => {
  await rm(WORK_ROOT, { recursive: true, force: true })
})

async function resetWorkspace(): Promise<void> {
  // Remove both files so each test starts from a known blank slate.
  // Mirrors what `ensureWorkspace()` would have done plus a wiped
  // proposals file.
  if (existsSync(PROFILE_PATH)) await rm(PROFILE_PATH)
  if (existsSync(PROPOSALS_PATH)) await rm(PROPOSALS_PATH)
}

beforeEach(async () => {
  await resetWorkspace()
})

const FULL_EXAMPLE = {
  name: 'Ada Lovelace',
  preferred_name: 'Ada',
  timezone: 'Europe/London',
  locale: 'en-GB',
  communication: {
    tone_default: 'direct',
    format_preference: 'prose',
    emoji: 'never',
    length_preference: 'medium',
  },
  work: {
    company: 'Acme Corp',
    role: 'Engineer',
    domains: ['mathematics', 'computing'],
  },
  personal: {
    location: 'London, UK',
    interests: ['mathematics', 'music', 'computing'],
  },
} satisfies Profile

describe('ProfileSchema', () => {
  test('accepts the empty object', () => {
    expect(ProfileSchema.safeParse({}).success).toBe(true)
  })

  test('accepts the canonical full example from AGENT_ARCHITECTURE.md L451-473', () => {
    const result = ProfileSchema.safeParse(FULL_EXAMPLE)
    expect(result.success).toBe(true)
  })

  test('rejects unknown top-level fields', () => {
    const result = ProfileSchema.safeParse({ name: 'Ada', foo: 'bar' })
    expect(result.success).toBe(false)
  })

  test('rejects unknown nested fields', () => {
    const result = ProfileSchema.safeParse({
      personal: { location: 'MA', mystery: 1 },
    })
    expect(result.success).toBe(false)
  })

  test('rejects invalid enum values', () => {
    const result = ProfileSchema.safeParse({
      communication: { tone_default: 'snarky' },
    })
    expect(result.success).toBe(false)
  })

  test('rejects wrong types', () => {
    const result = ProfileSchema.safeParse({
      work: { domains: 'mathematics' },
    })
    expect(result.success).toBe(false)
  })
})

describe('readProfile / writeProfile', () => {
  test('returns {} for a missing file', async () => {
    expect(await readProfile()).toEqual({})
  })

  test('returns {} for an empty file', async () => {
    await writeFile(PROFILE_PATH, '', 'utf8')
    expect(await readProfile()).toEqual({})
  })

  test('returns {} for malformed JSON', async () => {
    await writeFile(PROFILE_PATH, '{ this is not json', 'utf8')
    expect(await readProfile()).toEqual({})
  })

  test('returns {} for schema-invalid file (defensive)', async () => {
    await writeFile(
      PROFILE_PATH,
      JSON.stringify({ communication: { tone_default: 'snarky' } }),
      'utf8',
    )
    expect(await readProfile()).toEqual({})
  })

  test('round-trips the canonical full example', async () => {
    await writeProfile(FULL_EXAMPLE)
    expect(await readProfile()).toEqual(FULL_EXAMPLE)
  })

  test('rejects invalid input with ProfileValidationError', async () => {
    await expect(
      writeProfile({
        // @ts-expect-error — intentionally invalid for test
        communication: { tone_default: 'snarky' },
      }),
    ).rejects.toBeInstanceOf(ProfileValidationError)
  })

  test('atomic write does not leave a tmp file', async () => {
    await writeProfile({ name: 'Ada' })
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(WORK_ROOT)
    const tmps = entries.filter((e) => e.includes('profile.json.tmp'))
    expect(tmps).toEqual([])
  })
})

describe('proposeProfileChange', () => {
  test('enqueues a valid (field, value) pair and returns an id', async () => {
    const { proposalId } = await proposeProfileChange(
      'personal.location',
      'London, UK',
      'agent',
    )
    expect(typeof proposalId).toBe('string')
    expect(proposalId.length).toBeGreaterThan(0)

    const proposals = await listProfileProposals()
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({
      id: proposalId,
      field: 'personal.location',
      value: 'London, UK',
      proposed_by: 'agent',
    })
    expect(proposals[0]!.proposed_at).toBeTruthy()
  })

  test('does NOT modify profile.json', async () => {
    await proposeProfileChange('personal.location', 'London, UK', 'agent')
    expect(await readProfile()).toEqual({})
  })

  test('rejects unknown field paths with the canonical error message', async () => {
    await expect(
      proposeProfileChange('personal.foo', 'bar', 'agent'),
    ).rejects.toMatchObject({
      name: 'ProfileValidationError',
      message: "field 'personal.foo' is not in the profile schema",
    })
  })

  test('rejects unknown top-level field paths', async () => {
    await expect(
      proposeProfileChange('mystery', 'value', 'agent'),
    ).rejects.toMatchObject({
      name: 'ProfileValidationError',
      message: "field 'mystery' is not in the profile schema",
    })
  })

  test('rejects descending into a non-object leaf', async () => {
    // `name` is a string; `name.something` is not a valid path.
    await expect(
      proposeProfileChange('name.something', 'x', 'agent'),
    ).rejects.toBeInstanceOf(ProfileValidationError)
  })

  test('rejects invalid value types for a known field', async () => {
    await expect(
      proposeProfileChange('communication.tone_default', 'snarky', 'agent'),
    ).rejects.toBeInstanceOf(ProfileValidationError)
  })

  test('accepts a nested object value at an object-typed path', async () => {
    const { proposalId } = await proposeProfileChange(
      'communication',
      { tone_default: 'warm', emoji: 'sparingly' },
      'agent',
    )
    expect(proposalId).toBeTruthy()
  })

  test('multiple proposals coexist in the queue', async () => {
    await proposeProfileChange('personal.location', 'London, UK', 'agent')
    await proposeProfileChange('preferred_name', 'Ada', 'user')
    const proposals = await listProfileProposals()
    expect(proposals).toHaveLength(2)
  })
})

describe('acceptProfileProposal', () => {
  test('applies the dot-path change to profile.json', async () => {
    const { proposalId } = await proposeProfileChange(
      'personal.location',
      'London, UK',
      'agent',
    )
    await acceptProfileProposal(proposalId)

    const profile = await readProfile()
    expect(profile).toEqual({ personal: { location: 'London, UK' } })
  })

  test('removes the proposal from the queue after applying', async () => {
    const { proposalId } = await proposeProfileChange(
      'preferred_name',
      'Ada',
      'agent',
    )
    await acceptProfileProposal(proposalId)
    expect(await listProfileProposals()).toEqual([])
  })

  test('preserves other fields when applying', async () => {
    await writeProfile({ name: 'Ada Lovelace', preferred_name: 'Ada' })
    const { proposalId } = await proposeProfileChange(
      'personal.location',
      'London, UK',
      'agent',
    )
    await acceptProfileProposal(proposalId)
    const profile = await readProfile()
    expect(profile).toEqual({
      name: 'Ada Lovelace',
      preferred_name: 'Ada',
      personal: { location: 'London, UK' },
    })
  })

  test('is idempotent on a second call — proposal is gone, throws', async () => {
    const { proposalId } = await proposeProfileChange(
      'preferred_name',
      'Ada',
      'agent',
    )
    await acceptProfileProposal(proposalId)
    await expect(acceptProfileProposal(proposalId)).rejects.toBeInstanceOf(
      ProfileValidationError,
    )
  })

  test('throws on unknown proposal id', async () => {
    await expect(
      acceptProfileProposal('00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(ProfileValidationError)
  })

  test('persists JSON in a readable shape (pretty-printed)', async () => {
    const { proposalId } = await proposeProfileChange(
      'name',
      'Ada Lovelace',
      'user',
    )
    await acceptProfileProposal(proposalId)
    const raw = await readFile(PROFILE_PATH, 'utf8')
    expect(raw).toContain('\n')
    expect(JSON.parse(raw)).toEqual({ name: 'Ada Lovelace' })
  })
})

describe('rejectProfileProposal', () => {
  test('removes the proposal without touching profile.json', async () => {
    await writeProfile({ name: 'Ada Lovelace' })
    const { proposalId } = await proposeProfileChange(
      'personal.location',
      'London, UK',
      'agent',
    )
    await rejectProfileProposal(proposalId)

    expect(await listProfileProposals()).toEqual([])
    expect(await readProfile()).toEqual({ name: 'Ada Lovelace' })
  })

  test('throws on unknown proposal id', async () => {
    await expect(
      rejectProfileProposal('00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(ProfileValidationError)
  })

  test('only removes the targeted proposal', async () => {
    const { proposalId: keep } = await proposeProfileChange(
      'preferred_name',
      'Ada',
      'agent',
    )
    const { proposalId: drop } = await proposeProfileChange(
      'personal.location',
      'London, UK',
      'agent',
    )
    await rejectProfileProposal(drop)
    const remaining = await listProfileProposals()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.id).toBe(keep)
  })
})
