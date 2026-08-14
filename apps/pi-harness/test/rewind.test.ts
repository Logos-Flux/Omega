// Rewind-frame tests (X.C.2).
//
// Rewind has three observable behaviours:
//   1. Truncate conversation.jsonl at `toMessageId` (inclusive). Atomic
//      write — no half-written file on a crash.
//   2. Unknown id → return `{ ok: false, reason: 'not_found' }` without
//      mutating the file.
//   3. Cascade-cancel any in-flight turns on the same connection
//      before truncating, so an engine.run still appending can't
//      re-corrupt the file we just rewrote.
//
// Tests exercise `rewindConversation` (control.ts) and the underlying
// `truncateConversationAt` (memory.ts) directly. The WS frame layer
// is wired in src/index.ts but doesn't need its own test — it's a
// straight-through dispatch.

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK_ROOT = mkdtempSync(join(tmpdir(), 'pi-harness-rewind-'))
process.env.WORKSPACE_ROOT = WORK_ROOT
mkdirSync(join(WORK_ROOT, 'conversations'), { recursive: true })

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const { rewindConversation } = await import('../src/control')
type InFlightTurns = import('../src/control').InFlightTurns
const {
  appendConversation,
  readConversation,
  truncateConversationAt,
} = await import('../src/memory')

const SESSION = 'rewind-session-1'
const CONV_PATH = join(WORK_ROOT, 'conversations', `${SESSION}.jsonl`)

afterAll(async () => {
  await rm(WORK_ROOT, { recursive: true, force: true })
})

beforeEach(async () => {
  // Rebuild a fresh three-turn conversation before each test:
  //   user(turn-1)/assistant(turn-1) → user(turn-2)/assistant(turn-2)
  //     → user(turn-3)/assistant(turn-3)
  if (existsSync(CONV_PATH)) await rm(CONV_PATH)
  for (const i of [1, 2, 3]) {
    await appendConversation(SESSION, {
      ts: `2026-05-02T00:0${i}:00.000Z`,
      role: 'user',
      text: `prompt ${i}`,
      id: `turn-${i}`,
    })
    await appendConversation(SESSION, {
      ts: `2026-05-02T00:0${i}:01.000Z`,
      role: 'assistant',
      text: `reply ${i}`,
      id: `turn-${i}`,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
    })
  }
})

describe('truncateConversationAt (X.C.2)', () => {
  test('truncates inclusively at the FIRST matched line for the id', async () => {
    // User and assistant entries from the same turn share an id. The
    // truncation anchor is the first match (the user line), so the
    // assistant line for that turn is dropped along with everything
    // after. This matches "user edits their message and resubmits"
    // semantics: rewind to turn-N keeps the prompt-side history but
    // discards turn-N's reply and every later turn.
    const ok = await truncateConversationAt(SESSION, 'turn-2')
    expect(ok).toBe(true)
    const lines = await readConversation(SESSION)
    // Surviving: user-1, asst-1, user-2.  asst-2 + everything after gone.
    expect(lines).toHaveLength(3)
    expect(lines[lines.length - 1]).toMatchObject({
      role: 'user',
      text: 'prompt 2',
      id: 'turn-2',
    })
  })

  test('rewinding to the most recent user line drops only the trailing assistant', async () => {
    const before = await readConversation(SESSION)
    expect(before).toHaveLength(6)
    const ok = await truncateConversationAt(SESSION, 'turn-3')
    expect(ok).toBe(true)
    const after = await readConversation(SESSION)
    expect(after).toHaveLength(5)
    expect(after[after.length - 1]).toMatchObject({
      role: 'user',
      text: 'prompt 3',
      id: 'turn-3',
    })
  })

  test('returns false on unknown id and leaves the file untouched', async () => {
    const before = await readFile(CONV_PATH, 'utf8')
    const ok = await truncateConversationAt(SESSION, 'turn-does-not-exist')
    expect(ok).toBe(false)
    const after = await readFile(CONV_PATH, 'utf8')
    expect(after).toBe(before)
  })

  test('returns false on a never-written session', async () => {
    const ok = await truncateConversationAt('nonexistent-session', 'turn-1')
    expect(ok).toBe(false)
  })

  test('atomic write leaves no .tmp file behind', async () => {
    await truncateConversationAt(SESSION, 'turn-1')
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(join(WORK_ROOT, 'conversations'))
    expect(entries.some((e) => e.includes('.tmp.'))).toBe(false)
  })
})

describe('rewindConversation (X.C.2)', () => {
  test('returns { ok: true } and truncates when the id matches', async () => {
    const inflight: InFlightTurns = new Map()
    const result = await rewindConversation(SESSION, 'turn-2', inflight)
    expect(result).toEqual({ ok: true })
    const lines = await readConversation(SESSION)
    expect(lines).toHaveLength(3) // user-1, asst-1, user-2
  })

  test("returns { ok: false, reason: 'not_found' } for an unknown id", async () => {
    const inflight: InFlightTurns = new Map()
    const result = await rewindConversation(
      SESSION,
      'no-such-turn',
      inflight,
    )
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  test('cascade-cancels every in-flight controller before truncating', async () => {
    const inflight: InFlightTurns = new Map()
    const a = new AbortController()
    const b = new AbortController()
    inflight.set('turn-A', { ctrl: a, done: Promise.resolve() })
    inflight.set('turn-B', { ctrl: b, done: Promise.resolve() })

    const result = await rewindConversation(SESSION, 'turn-2', inflight)
    expect(result.ok).toBe(true)
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
    // Map is cleared as part of cascade-cancel.
    expect(inflight.size).toBe(0)
  })

  test('cascade-cancels even when the rewind itself fails (not_found)', async () => {
    // Documented behaviour: cancel-all happens before the truncate
    // attempt, so a rewind to an unknown id still tears down active
    // turns. A frontend that fires rewind for an id it can't see
    // shouldn't be the one keeping a stalled stream alive.
    const inflight: InFlightTurns = new Map()
    const ctrl = new AbortController()
    inflight.set('turn-A', { ctrl, done: Promise.resolve() })
    const result = await rewindConversation(
      SESSION,
      'no-such-turn',
      inflight,
    )
    expect(result.ok).toBe(false)
    expect(ctrl.signal.aborted).toBe(true)
  })

  test('preserves jsonl shape — every kept line ends with a newline', async () => {
    const inflight: InFlightTurns = new Map()
    await rewindConversation(SESSION, 'turn-1', inflight)
    const raw = await readFile(CONV_PATH, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    // No empty lines; every line parses.
    const lines = raw.split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      expect(() => JSON.parse(l)).not.toThrow()
    }
  })
})

// ---
// Pre-X.C compat: legacy entries written without an `id` field still
// load fine via readConversation, and a rewind that names an id never
// matches them (because their id is `undefined`). This is the
// expected behaviour — there's no way to address those entries — and
// is documented here so a future change can't silently regress it.
// ---

describe('rewind backwards-compat with legacy id-less entries', () => {
  test('legacy entries are skipped by id lookup', async () => {
    // Wipe the seeded session and write two legacy lines.
    if (existsSync(CONV_PATH)) await rm(CONV_PATH)
    const legacy = [
      JSON.stringify({
        ts: '2026-04-01T00:00:00.000Z',
        role: 'user',
        text: 'old prompt',
      }),
      JSON.stringify({
        ts: '2026-04-01T00:00:01.000Z',
        role: 'assistant',
        text: 'old reply',
      }),
    ].join('\n') + '\n'
    await writeFile(CONV_PATH, legacy, 'utf8')

    const ok = await truncateConversationAt(SESSION, 'turn-1')
    expect(ok).toBe(false)
    // Legacy lines untouched.
    const after = await readFile(CONV_PATH, 'utf8')
    expect(after).toBe(legacy)
  })
})
