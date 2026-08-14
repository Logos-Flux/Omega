import { describe, expect, test } from 'bun:test'
import { cancelTurn, cancelAllTurns, type InFlightTurns } from './control'

// BUG-04 — rewind must await in-flight turns (not just abort them) before the
// caller truncates the conversation file, or the engine's trailing partial-
// assistant append lands AFTER the truncate and re-corrupts the file.

describe('cancelAllTurns (BUG-04)', () => {
  test('aborts every turn AND waits for each to settle before resolving', async () => {
    let trailingAppendDone = false
    const ctrl = new AbortController()
    // Simulate engine.run: on abort it still does a trailing append (the
    // partial-assistant write) before its promise settles.
    const done = (async () => {
      await new Promise((r) => setTimeout(r, 15))
      trailingAppendDone = true
    })()
    const inflight: InFlightTurns = new Map([['t1', { ctrl, done }]])

    await cancelAllTurns(inflight)

    // The await is the whole point: by the time cancelAllTurns resolves, the
    // simulated trailing append has finished — so a subsequent truncate can't
    // race it.
    expect(trailingAppendDone).toBe(true)
    expect(ctrl.signal.aborted).toBe(true)
    expect(inflight.size).toBe(0)
  })

  test('resolves immediately when there are no in-flight turns', async () => {
    const inflight: InFlightTurns = new Map()
    await cancelAllTurns(inflight)
    expect(inflight.size).toBe(0)
  })
})

describe('cancelTurn', () => {
  test('aborts and removes the matching turn', () => {
    const ctrl = new AbortController()
    const inflight: InFlightTurns = new Map([['t1', { ctrl, done: Promise.resolve() }]])
    cancelTurn('t1', inflight, () => {})
    expect(ctrl.signal.aborted).toBe(true)
    expect(inflight.has('t1')).toBe(false)
  })

  test('is a silent no-op for an unknown turn id', () => {
    const ctrl = new AbortController()
    const inflight: InFlightTurns = new Map([['t1', { ctrl, done: Promise.resolve() }]])
    cancelTurn('does-not-exist', inflight, () => {})
    expect(ctrl.signal.aborted).toBe(false)
    expect(inflight.has('t1')).toBe(true)
  })
})
