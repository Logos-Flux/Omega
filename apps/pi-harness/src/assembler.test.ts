import { describe, expect, test, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// BUG-02 — every Agent-Mode turn used to send the latest user prompt twice
// ("X\n\nX"). engine.run persisted the user message BEFORE PromptAssembler
// .build ran, so slot 14 (conversation history) already contained the
// in-flight turn and slot 15 re-appended it. The engine fix builds first,
// then persists, so history never contains the current turn. These tests
// pin the assembler's slot-14/15 contract that the fix relies on.
//
// Leak-free by construction: PromptAssembler.build assembles messages from
// the workspace files only — it does NOT call the model — so no shared module
// (ai / memory) needs mocking. We point WORKSPACE_ROOT at a temp dir.

const tmp = mkdtempSync(join(tmpdir(), 'omega-assembler-'))
mkdirSync(join(tmp, 'conversations'), { recursive: true })
process.env.WORKSPACE_ROOT = tmp

const { PromptAssembler } = await import('./assembler')
const { dispatchUser } = await import('./dispatcher')

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
  delete process.env.WORKSPACE_ROOT
})

function writeConversation(sessionId: string, lines: Array<Record<string, unknown>>): void {
  writeFileSync(
    join(tmp, 'conversations', `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  )
}

function lastUserText(payload: { modelMessages: Array<{ role: string; content: unknown }> }): string {
  const users = payload.modelMessages.filter((m) => m.role === 'user')
  const last = users[users.length - 1]
  return typeof last?.content === 'string' ? last.content : ''
}

describe('PromptAssembler slot 14/15 (BUG-02)', () => {
  test('appends the latest prompt exactly once when history excludes it', async () => {
    const sessionId = 's-bug02-a'
    // History WITHOUT the current turn — the post-fix engine ordering.
    writeConversation(sessionId, [
      { ts: '2026-01-01T00:00:00Z', role: 'user', text: 'earlier question', id: 'm0' },
      { ts: '2026-01-01T00:00:01Z', role: 'assistant', text: 'earlier answer', id: 'm0' },
    ])
    const inv = dispatchUser({ type: 'send', id: 'm1', sessionId, content: 'CURRENT_PROMPT_XYZ' }, { userId: 'u1' })
    const text = lastUserText(await PromptAssembler.build(inv))
    expect(text.split('CURRENT_PROMPT_XYZ').length - 1).toBe(1)
  })

  test('regression guard: a turn already in history doubles — which is why engine persists AFTER build', async () => {
    const sessionId = 's-bug02-b'
    // Simulate the OLD ordering (current turn already persisted before build).
    writeConversation(sessionId, [
      { ts: '2026-01-01T00:00:00Z', role: 'user', text: 'CURRENT_PROMPT_XYZ', id: 'm1' },
    ])
    const inv = dispatchUser({ type: 'send', id: 'm1', sessionId, content: 'CURRENT_PROMPT_XYZ' }, { userId: 'u1' })
    const text = lastUserText(await PromptAssembler.build(inv))
    // Pre-fix behaviour: slot 14 already had it + slot 15 re-appends → twice.
    expect(text.split('CURRENT_PROMPT_XYZ').length - 1).toBe(2)
  })
})
