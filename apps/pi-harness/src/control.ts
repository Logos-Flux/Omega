// Control-plane WS handlers — cancel + rewind (X.C.1, X.C.2).
//
// These frames are NOT user turns. They don't go through the
// dispatcher / assembler / engine pipeline; they mutate connection
// state (cancel) or workspace state (rewind) and emit a single
// confirmation event. Keeping them here, rather than inside the
// engine, means the engine stays a pure inference loop and the
// control surface is unit-testable without booting a WebSocket.
//
// Lifecycle of an in-flight turn:
//   1. WS receives `{ type: 'send', id, ... }`.
//   2. Handler creates an AbortController, stores it in the per-WS
//      `Map<turnId, AbortController>`, hands the signal to engine.run.
//   3. Engine runs to completion or until the signal fires. Either
//      way, the handler removes the entry from the map after run()
//      resolves.
//   4. If a `cancel` frame arrives while the engine is mid-stream,
//      cancelTurn() looks up the controller and calls .abort(). The
//      streamText loop throws AbortError; engine emits `done` with
//      `cancelled: true` and persists the partial assistant message.
//
// Rewind cascades cancel: rewinding while a turn is in-flight is
// always a footgun (the engine would still be appending to the file
// the rewind just truncated), so the rule is "abort everything in
// flight on this connection first, then truncate." The frontend
// shouldn't normally fire rewind during a turn — the UI should
// disable the affordance while streaming — but defending in depth
// here means a misbehaving client can't corrupt the file.

import { truncateConversationAt } from './memory'
import type { Outgoing } from './types'

/**
 * One in-flight turn: its AbortController plus the promise that resolves
 * when engine.run() has fully unwound — INCLUDING the engine's trailing
 * partial-assistant append on abort. Rewind must await `done` (BUG-04), not
 * just fire `abort()`, or the late append lands after the truncate.
 */
export interface InFlightTurn {
  ctrl: AbortController
  done: Promise<void>
}

/**
 * Per-WS in-flight turn registry. One entry per active streamText
 * call; cleared automatically when the WS closes (the Map is owned
 * by the connection's `data` slot).
 */
export type InFlightTurns = Map<string, InFlightTurn>

export function cancelTurn(
  turnId: string,
  inflight: InFlightTurns,
  emit: (out: Outgoing) => void,
): void {
  const entry = inflight.get(turnId)
  if (!entry) {
    // X.C.1 — silent no-op for unknown ids. The client may have
    // pressed Stop after the turn already finished; that's fine.
    // Emitting an error here would be misleading.
    return
  }
  entry.ctrl.abort()
  inflight.delete(turnId)
  // Don't emit `done` from here — the engine's catch handler does
  // that once the streamText loop unwinds. Emitting from both sides
  // would race and double-fire on the wire.
  void emit
}

/**
 * Cancel every in-flight turn for this connection AND wait for each run to
 * finish unwinding. Used by the rewind handler so no streamText loop is still
 * appending to a conversation file we're about to truncate (BUG-04). Without
 * the await, the engine's trailing partial-assistant append races the
 * truncate and re-corrupts the file after the rewind.
 */
export async function cancelAllTurns(inflight: InFlightTurns): Promise<void> {
  const pending = [...inflight.values()].map((e) => {
    e.ctrl.abort()
    return e.done
  })
  inflight.clear()
  await Promise.allSettled(pending)
}

export interface RewindResult {
  ok: boolean
  reason?: 'not_found'
}

export async function rewindConversation(
  sessionId: string,
  toMessageId: string,
  inflight: InFlightTurns,
): Promise<RewindResult> {
  // Cascade-cancel AND await before truncating so no engine.run() is still
  // mid-append. The engine's trailing assistant entry would otherwise land
  // after the rewind and re-corrupt the file (BUG-04).
  await cancelAllTurns(inflight)
  const truncated = await truncateConversationAt(sessionId, toMessageId)
  if (!truncated) return { ok: false, reason: 'not_found' }
  return { ok: true }
}
