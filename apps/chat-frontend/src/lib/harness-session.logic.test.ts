// Pure-logic tests for the session-mirror decision extracted in WP #895.
//
// The Uploads panel silently dropped files because two bugs compounded:
//   (A) uploadFiles had try/finally but no catch — a thrown POST was
//       swallowed by `void uploadFiles(...)`;
//   (B) the 1s session poller closed over a stale `session` (its effect
//       listed only [transport] with exhaustive-deps disabled), so the
//       `else if (!snapshot && session)` clear-branch was dead code: a
//       suspended sprite was never cleared and the drawer kept offering
//       "Add file" against a dead container with a possibly-expired token.
//
// Fix (B) routes the poller through nextSessionState fed a LIVE session
// via a ref. These tests pin that decision table directly — no DOM, no
// timers — so the dead-session-clear and same-session de-dupe can't
// silently regress. (Component-level coverage lives in
// harness-session.test.tsx.)

import { test, expect } from 'bun:test'
import { nextSessionState, SESSION_UNCHANGED } from './harness-session'

// Build a session snapshot (or null). Structurally matches HarnessSessionState,
// which is what nextSessionState consumes; the type isn't exported, so we
// rely on structural compatibility rather than naming it.
const mk = (id: string | null) =>
  id === null
    ? null
    : {
        sessionId: id,
        token: `tok-${id}`,
        container: { name: 'pi-spike-01', url: 'https://sprite.example', provider: 'sprites' },
      }

test('adopts a session when nothing was mirrored yet', () => {
  const r = nextSessionState(null, mk('a'))
  expect(r).not.toBe(SESSION_UNCHANGED)
  expect((r as { sessionId: string } | null)?.sessionId).toBe('a')
})

test('clears a dead session — the regression: previously dead code', () => {
  // A session was mirrored, the transport now reports none -> must clear
  // to null, NOT no-op. This is exactly the branch the stale-closure
  // poller never reached, so a suspended sprite was never cleared.
  expect(nextSessionState(mk('a'), null)).toBe(null)
})

test('swaps when the sessionId changes', () => {
  const r = nextSessionState(mk('a'), mk('b'))
  expect((r as { sessionId: string } | null)?.sessionId).toBe('b')
})

test('no-op on the same sessionId even for a fresh object (kills the per-tick cascade)', () => {
  // getActiveSession() returns a brand-new object every call; without the
  // sessionId de-dupe the poller would setSession every tick and re-run
  // the /uploads + /skills effects once per second per tab.
  expect(nextSessionState(mk('a'), mk('a'))).toBe(SESSION_UNCHANGED)
})

test('two nulls is a no-op', () => {
  expect(nextSessionState(null, null)).toBe(SESSION_UNCHANGED)
})

test('returns a snapshot object that does not share identity with the input', () => {
  // The poller stores the result in state; ensure nextSessionState doesn't
  // hand back the transport's internal object verbatim (callers mutate
  // state objects at their peril).
  const input = mk('a') as { sessionId: string }
  const r = nextSessionState(null, input) as { sessionId: string }
  expect(r).not.toBe(input)
  expect(r.sessionId).toBe('a')
})
