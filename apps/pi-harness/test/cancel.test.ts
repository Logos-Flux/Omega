// Cancel-frame tests (X.C.1).
//
// Two layers:
//   1. control.ts unit tests — `cancelTurn` aborts a registered
//      controller, no-ops on unknown ids, and cascade-aborts every
//      controller in the map.
//   2. engine.ts integration tests — wire a MockLanguageModelV3 that
//      emits a few text deltas and then stalls, fire engine.run with
//      an AbortController whose signal is wired through ctx, abort
//      mid-stream, and verify:
//        - `done` event carries `cancelled: true`
//        - conversation.jsonl gains a `partial: true` assistant entry
//          with the deltas emitted before the abort.
//
// `WORKSPACE_ROOT` must be set BEFORE any import that transitively
// pulls src/memory.ts (the canonical-path resolution captures the env
// var lazily, but the snapshot test history shows other consumers
// snapshot at module load — keep the safe pattern here).

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK_ROOT = mkdtempSync(join(tmpdir(), 'pi-harness-cancel-'))
process.env.WORKSPACE_ROOT = WORK_ROOT
mkdirSync(join(WORK_ROOT, 'conversations'), { recursive: true })

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { MockLanguageModelV3 } from 'ai/test'
import type { Outgoing } from '../src/types'

// Dynamic imports — `WORKSPACE_ROOT` is captured at module-load time
// by `src/memory.ts` (and transitively by everything that imports it),
// so any static `import ... from '../src/...'` would evaluate before
// the env-var assignment above and freeze WORKSPACE_ROOT to '/workspace'.
// Awaiting the imports here keeps the ordering honest.
const { cancelAllTurns, cancelTurn } = await import('../src/control')
type InFlightTurns = import('../src/control').InFlightTurns
const { PROVIDERS } = await import('../src/providers')
const { run: runEngine } = await import('../src/engine')
const { readConversation } = await import('../src/memory')

afterAll(async () => {
  await rm(WORK_ROOT, { recursive: true, force: true })
})

// ---
// MockLanguageModelV3 helper. Emits N text deltas, each followed by a
// short tick; the stream stays "alive" indefinitely until aborted.
// streamText forwards the abortSignal to the underlying model's stream
// reader, so closing the controller's signal cancels the loop.
// ---
function makeBlockingMock(textChunks: string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async ({ abortSignal }) => {
      let i = 0
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          controller.enqueue({ type: 'text-start', id: '0' })
        },
        async pull(controller) {
          // If the consumer aborted while we were idle, terminate the
          // stream cleanly so streamText surfaces the AbortError.
          if (abortSignal?.aborted) {
            controller.error(
              Object.assign(new Error('aborted'), { name: 'AbortError' }),
            )
            return
          }
          if (i < textChunks.length) {
            controller.enqueue({
              type: 'text-delta',
              id: '0',
              delta: textChunks[i]!,
            })
            i++
            return
          }
          // After all deltas, stall until aborted. Polling on a tiny
          // interval keeps the test deterministic without busy-looping
          // — abort fires synchronously, the next tick sees it.
          await new Promise<void>((resolve) => {
            const tick = () => {
              if (abortSignal?.aborted) return resolve()
              setTimeout(tick, 5)
            }
            tick()
          })
          controller.error(
            Object.assign(new Error('aborted'), { name: 'AbortError' }),
          )
        },
      })
      return { stream }
    },
  })
}

// ---
// 1. control.ts helpers.
// ---

describe('cancelTurn (X.C.1)', () => {
  test('aborts the registered controller and removes the entry', () => {
    const inflight: InFlightTurns = new Map()
    const ctrl = new AbortController()
    inflight.set('turn-1', ctrl)
    cancelTurn('turn-1', inflight, () => {})
    expect(ctrl.signal.aborted).toBe(true)
    expect(inflight.has('turn-1')).toBe(false)
  })

  test('is a silent no-op for an unknown id', () => {
    const inflight: InFlightTurns = new Map()
    const ctrl = new AbortController()
    inflight.set('turn-1', ctrl)
    cancelTurn('does-not-exist', inflight, () => {})
    // The unrelated controller stays untouched.
    expect(ctrl.signal.aborted).toBe(false)
    expect(inflight.has('turn-1')).toBe(true)
  })

  test('does NOT emit a done event itself — engine emits the trailing done', () => {
    const inflight: InFlightTurns = new Map()
    inflight.set('turn-1', new AbortController())
    const events: Outgoing[] = []
    cancelTurn('turn-1', inflight, (out) => events.push(out))
    expect(events).toEqual([])
  })
})

describe('cancelAllTurns (X.C.2 cascade)', () => {
  test('aborts every registered controller and clears the map', () => {
    const inflight: InFlightTurns = new Map()
    const a = new AbortController()
    const b = new AbortController()
    inflight.set('a', a)
    inflight.set('b', b)
    cancelAllTurns(inflight)
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
    expect(inflight.size).toBe(0)
  })

  test('is a no-op on an empty map', () => {
    const inflight: InFlightTurns = new Map()
    expect(() => cancelAllTurns(inflight)).not.toThrow()
  })
})

// ---
// 2. Engine integration — wire the mock into PROVIDERS.anthropic and
//    drive runEngine. We restore the original resolver after each test
//    so subsequent tests aren't poisoned.
// ---

describe('engine cancel path (X.C.1)', () => {
  let originalResolve: (model: string) => unknown

  beforeEach(() => {
    originalResolve = PROVIDERS.anthropic.resolve
  })

  function restoreResolver() {
    ;(PROVIDERS.anthropic as { resolve: (m: string) => unknown }).resolve =
      originalResolve
  }

  test('aborting mid-stream emits done{cancelled:true} and persists a partial assistant entry', async () => {
    const mock = makeBlockingMock(['Hello ', 'partial'])
    ;(PROVIDERS.anthropic as { resolve: (m: string) => unknown }).resolve = () =>
      mock

    const events: Outgoing[] = []
    const emit = (o: Outgoing) => events.push(o)
    const ctrl = new AbortController()

    // Fire the engine on a session id that doesn't yet exist; engine.run
    // will create the conversation file via appendConversation.
    const sessionId = 'cancel-session-1'
    const turnId = 'turn-1'

    const runPromise = runEngine(
      {
        type: 'send',
        id: turnId,
        sessionId,
        content: 'hi',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
      },
      emit,
      { userId: 'u', signal: ctrl.signal },
    )

    // Wait until the mock has emitted both deltas, then abort. The
    // mock stalls in pull() after all deltas land, so by the time we
    // see two deltas the engine is sitting on the stream waiting.
    await new Promise<void>((resolve) => {
      const check = () => {
        const deltaCount = events.filter((e) => e.type === 'delta').length
        if (deltaCount >= 2) return resolve()
        setTimeout(check, 5)
      }
      check()
    })

    ctrl.abort()
    await runPromise

    // Done event present with cancelled: true.
    const done = events.find((e) => e.type === 'done')
    expect(done).toBeTruthy()
    expect(done).toMatchObject({
      type: 'done',
      id: turnId,
      cancelled: true,
    })

    // No error event.
    expect(events.some((e) => e.type === 'error')).toBe(false)

    // conversation.jsonl: user line + partial assistant line.
    const lines = await readConversation(sessionId)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ role: 'user', text: 'hi', id: turnId })
    expect(lines[1]).toMatchObject({
      role: 'assistant',
      partial: true,
      id: turnId,
    })
    // The partial text is whatever was emitted before the abort.
    expect(lines[1]!.text).toContain('Hello')

    restoreResolver()
  })

  test('a turn that completes naturally has no `cancelled` flag and no `partial` entry', async () => {
    // A mock that emits deltas and then immediately finishes — no
    // stalling. This is the happy-path control case for the cancel
    // wiring: the abortSignal exists but is never tripped.
    const mock = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] })
            controller.enqueue({ type: 'text-start', id: '0' })
            controller.enqueue({
              type: 'text-delta',
              id: '0',
              delta: 'all done',
            })
            controller.enqueue({ type: 'text-end', id: '0' })
            // Cast the finish chunk to the permissive Provider V3
            // shape rather than spelling out the full nested usage
            // tree — the engine only consumes finishReason, so a
            // structurally-compatible value is sufficient.
            controller.enqueue({
              type: 'finish',
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
                totalTokens: 2,
              },
              finishReason: { unified: 'stop', raw: 'stop' },
            } as never)
            controller.close()
          },
        }),
      }),
    })
    ;(PROVIDERS.anthropic as { resolve: (m: string) => unknown }).resolve = () =>
      mock

    const events: Outgoing[] = []
    const emit = (o: Outgoing) => events.push(o)
    const ctrl = new AbortController()
    const sessionId = 'cancel-session-2'
    const turnId = 'turn-2'

    await runEngine(
      {
        type: 'send',
        id: turnId,
        sessionId,
        content: 'hello',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
      },
      emit,
      { userId: 'u', signal: ctrl.signal },
    )

    const done = events.find((e) => e.type === 'done')
    expect(done).toBeTruthy()
    // `cancelled` is omitted (not `false`) for natural completion —
    // the wire shape uses the optional flag pattern.
    expect((done as { cancelled?: boolean }).cancelled).toBeUndefined()

    const lines = await readConversation(sessionId)
    const assistant = lines.find((l) => l.role === 'assistant')
    expect(assistant).toBeTruthy()
    expect(assistant!.partial).toBeUndefined()

    restoreResolver()
  })
})
