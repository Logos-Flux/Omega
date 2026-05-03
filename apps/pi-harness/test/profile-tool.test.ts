// Tests for the `update_profile` model-callable tool — Phase II.A.2.
//
// The tool wraps `proposeProfileChange` from src/profile.ts; the
// underlying primitive already has thorough coverage in
// test/profile.test.ts. These tests focus on the tool surface itself:
// happy-path proposal id round-trip, validation-error mapping to a
// structured `{ ok: false, error }` shape (rather than throwing — the
// AI SDK would surface a thrown error as a tool-result error, which is
// noisier than a clean `{ ok: false }` the model can describe to the
// user).
//
// We materialise the tool by importing the assembler and calling
// `toolsForProvider` indirectly via PromptAssembler.build — but a direct
// path is cleaner: exercise the tool's `execute` callback by reading
// it out of the assembled toolset for a representative invocation.
//
// The toolset is constructed inside the assembler and isn't exported,
// so we go through a minimal Invocation. WORKSPACE_ROOT is set BEFORE
// imports per the test/profile.test.ts pattern.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK_ROOT = mkdtempSync(join(tmpdir(), 'pi-harness-profile-tool-'))
process.env.WORKSPACE_ROOT = WORK_ROOT

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'

const { PromptAssembler } = await import('../src/assembler')
const { listProfileProposals } = await import('../src/profile')
import type { Invocation } from '../src/types'

const PROFILE_PATH = join(WORK_ROOT, 'profile.json')
const PROPOSALS_PATH = join(WORK_ROOT, 'profile.proposals.json')

afterAll(async () => {
  await rm(WORK_ROOT, { recursive: true, force: true })
})

beforeEach(async () => {
  if (existsSync(PROFILE_PATH)) await rm(PROFILE_PATH)
  if (existsSync(PROPOSALS_PATH)) await rm(PROPOSALS_PATH)
})

function baseInvocation(): Invocation {
  return {
    trigger: 'user',
    inputType: 'prompt',
    sessionId: 'tool-test-session',
    userId: 'tool-test-user',
    personaName: 'default',
    soulName: 'default',
    prompt: 'hi',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    budget: {},
    policy: {},
    delivery: 'ws',
  }
}

interface ToolWithExecute {
  execute: (
    args: { field: string; value: unknown },
    ctx: unknown,
  ) => Promise<unknown>
}

async function getUpdateProfileTool(): Promise<ToolWithExecute> {
  const payload = await PromptAssembler.build(baseInvocation())
  const tool = (payload.tools as Record<string, unknown> | undefined)?.[
    'update_profile'
  ]
  if (!tool) throw new Error('update_profile tool missing from toolset')
  return tool as ToolWithExecute
}

describe('update_profile tool', () => {
  test('happy path: enqueues a proposal and returns the id', async () => {
    const tool = await getUpdateProfileTool()
    const result = (await tool.execute(
      { field: 'personal.location', value: 'Acton, MA' },
      {},
    )) as { ok: boolean; proposalId?: string; message?: string; error?: string }

    expect(result.ok).toBe(true)
    expect(typeof result.proposalId).toBe('string')
    expect(result.message).toBe('queued for confirmation')

    const proposals = await listProfileProposals()
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({
      id: result.proposalId,
      field: 'personal.location',
      value: 'Acton, MA',
      proposed_by: 'agent',
    })
  })

  test('unknown field path: returns ok=false with the canonical message', async () => {
    const tool = await getUpdateProfileTool()
    const result = (await tool.execute(
      { field: 'personal.foo', value: 'bar' },
      {},
    )) as { ok: boolean; error?: string }

    expect(result.ok).toBe(false)
    expect(result.error).toBe("field 'personal.foo' is not in the profile schema")
    expect(await listProfileProposals()).toHaveLength(0)
  })

  test('invalid value type: returns ok=false', async () => {
    const tool = await getUpdateProfileTool()
    const result = (await tool.execute(
      { field: 'communication.tone_default', value: 'snarky' },
      {},
    )) as { ok: boolean; error?: string }

    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(result.error).toContain('communication.tone_default')
    expect(await listProfileProposals()).toHaveLength(0)
  })
})
