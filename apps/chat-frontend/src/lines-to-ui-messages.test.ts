// Regression test for the "clicking any agent thread white-screens the app" bug.
//
// Root cause: the harness writes a turn's user AND assistant jsonl lines with
// the SAME frame id (engine.ts — it doubles as the rewind anchor). When a
// resumed thread's history was mapped straight to UIMessages, those duplicate
// ids reached assistant-ui's MessageRepository, which keys messages by id and
// THROWS on a duplicate ("a message with the same id already exists in the
// parent tree"). With no error boundary that uncaught render error blanked the
// whole app. linesToUIMessages must therefore emit unique ids.

import { test, expect } from 'bun:test'
import { linesToUIMessages } from './App'
import type { ConversationLine } from './lib/harness-api'

// A two-turn conversation as the harness persists it: each turn's user and
// assistant line share the turn's frame id.
const lines: ConversationLine[] = [
  { ts: '2026-06-16T00:00:00Z', role: 'user', text: 'hi', id: 'turn-1' },
  { ts: '2026-06-16T00:00:01Z', role: 'assistant', text: 'hello', id: 'turn-1' },
  { ts: '2026-06-16T00:00:02Z', role: 'user', text: 'more', id: 'turn-2' },
  { ts: '2026-06-16T00:00:03Z', role: 'assistant', text: 'sure', id: 'turn-2' },
]

test('assigns a unique id to every message even when frame ids repeat', () => {
  const msgs = linesToUIMessages(lines)
  const ids = msgs.map((m) => m.id)
  expect(new Set(ids).size).toBe(ids.length)
})

test('preserves role and text, one text part per line', () => {
  const msgs = linesToUIMessages(lines)
  expect(msgs).toHaveLength(4)
  expect(msgs[0].role).toBe('user')
  expect(msgs[1].role).toBe('assistant')
  expect(msgs[1].parts).toEqual([{ type: 'text', text: 'hello' }])
})

test('handles lines with no id (legacy) without colliding', () => {
  const legacy: ConversationLine[] = [
    { ts: '2026-06-16T00:00:00Z', role: 'user', text: 'a' },
    { ts: '2026-06-16T00:00:01Z', role: 'assistant', text: 'b' },
  ]
  const ids = linesToUIMessages(legacy).map((m) => m.id)
  expect(new Set(ids).size).toBe(2)
})
