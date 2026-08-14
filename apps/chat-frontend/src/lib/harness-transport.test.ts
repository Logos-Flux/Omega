// Regression test for the "stuck on Connecting to sprite" bug.
//
// `connect()` (the eager-open path wired from HarnessSessionProvider's
// mount effect) drives the phase to `connecting` via openSession() and,
// before the fix, returned without ever moving it on — there's no
// message-send to flip it to `thinking` like the lazy path has. The
// indicator was therefore stranded showing "Connecting to sprite" even
// though the WS had opened successfully. The fix lands the phase on
// `idle` ("Ready") once connected.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { HarnessTransport } from './harness-transport'

// Minimal WebSocket stand-in: fires `open` on the next microtask (after
// the transport has attached its listeners), reports OPEN readyState.
class MockWebSocket {
  static OPEN = 1
  readyState = 1
  url: string
  private listeners: Record<string, Array<(ev: unknown) => void>> = {}
  constructor(url: string) {
    this.url = url
    queueMicrotask(() => this.dispatch('open'))
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    ;(this.listeners[type] ??= []).push(fn)
  }
  dispatch(type: string, ev: unknown = {}) {
    for (const fn of this.listeners[type] ?? []) fn(ev)
  }
  send() {}
  close() {}
}

// Save the real globals so we can restore them after each test. Without
// this, the stubbed `fetch` leaks out of this file and into every test that
// runs after it in the same bun process — notably the cf-access JWKS
// verifier tests, whose `createRemoteJWKSet` then calls a stub fetch that
// returns no real status and throws "Expected 200 OK from the JSON Web Key
// Set HTTP response" before reaching the assertion under test.
const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_WEBSOCKET = globalThis.WebSocket

beforeEach(() => {
  // Controller returns a healthy session; WS opens immediately.
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      sessionId: 'sess-1',
      token: 'jwt-token',
      container: { name: 'pi-spike-01', url: 'https://sprite.example', provider: 'sprites' },
    }),
  })) as unknown as typeof fetch
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  globalThis.WebSocket = ORIGINAL_WEBSOCKET
})

test('connect() lands on idle after the WS opens (no stranded "connecting")', async () => {
  const t = new HarnessTransport({
    apiBase: '/chat',
    getProviderSelection: () => ({ provider: 'anthropic', model: 'claude' }),
  })

  const seen: string[] = []
  t.subscribePhase((p) => seen.push(p.kind))

  await t.connect()

  // It must pass *through* connecting (proves we exercised the real path)…
  expect(seen).toContain('connecting')
  // …and must not be left there. Pre-fix this was 'connecting'.
  expect(t.getPhase().kind).toBe('idle')
})

test('connect() is idempotent and stays idle on a second call', async () => {
  const t = new HarnessTransport({
    apiBase: '/chat',
    getProviderSelection: () => ({ provider: 'anthropic', model: 'claude' }),
  })
  await t.connect()
  await t.connect()
  expect(t.getPhase().kind).toBe('idle')
})

// ---------------------------------------------------------------------------
// WP-894 — Agent Mode minted a NEW sessionId on every WS reconnect, so
// conversation history + uploads vanished between turns. The fix: adopt the
// controller-minted sessionId as the resume target after the first open, so a
// reconnect POSTs {resumeSessionId} and the controller resumes the same
// session. Plus a WS keepalive watchdog so a half-dead socket (laptop sleep)
// is detected and forced through that same reconnect→resume path instead of
// stranding the user on "Thinking…".

// A richer WS stand-in for the WP-894 tests: records every `send()` payload,
// and lets a test dispatch inbound frames ('message') or simulate a drop
// ('close'). Fires 'open' on the next microtask — after the transport has
// attached its listeners — mirroring MockWebSocket above.
class RecordingWebSocket {
  static OPEN = 1
  static CLOSED = 3
  readyState = 1 as const
  url: string
  sent: unknown[] = []
  private listeners: Record<string, Array<(ev: unknown) => void>> = {}
  constructor(url: string) {
    this.url = url
    queueMicrotask(() => this.dispatch('open'))
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    ;(this.listeners[type] ??= []).push(fn)
  }
  dispatch(type: string, ev: unknown = {}) {
    for (const fn of this.listeners[type] ?? []) fn(ev)
  }
  /** Push an inbound JSON frame as a 'message' event (the transport parses it). */
  dispatchMessage(frame: unknown) {
    this.dispatch('message', { data: JSON.stringify(frame) })
  }
  send(payload: string) {
    this.sent.push(JSON.parse(payload))
  }
  close() {
    this.readyState = 3 as unknown as 1
    this.dispatch('close')
  }
}

// Wire globalThis.fetch + WebSocket to recorders that return a stable
// sess-1. Returns hooks the tests assert against. Restored by afterEach.
function useRecordingEnv() {
  const startBodies: string[] = []
  const sockets: RecordingWebSocket[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/api/controller/api/session/start')) {
      startBodies.push(init?.body ? String(init.body) : '')
    }
    return {
      ok: true,
      json: async () => ({
        sessionId: 'sess-1',
        token: 'jwt',
        container: {
          name: 'sprite-1',
          url: 'https://sprite.example',
          provider: 'sprites',
        },
      }),
    } as Response
  }) as unknown as typeof fetch
  globalThis.WebSocket = function WebSocket(url: string) {
    const s = new RecordingWebSocket(url)
    sockets.push(s)
    return s
  } as unknown as typeof WebSocket
  // The transport compares against `WebSocket.OPEN` — expose it on the factory.
  ;(globalThis.WebSocket as unknown as { OPEN: number }).OPEN = 1
  return { startBodies, sockets }
}

// Cast helper: tests poke the watchdog's private state directly for fully
// deterministic, timer-free assertions (bun:test has no fake timers).
interface WatchdogInternals {
  keepaliveIntervalMs: number
  keepaliveTimeoutMs: number
  lastInboundAt: number
  pingSentAt: number
  keepaliveTick(ws: WebSocket): void
}
const watchdog = (t: HarnessTransport): WatchdogInternals =>
  t as unknown as WatchdogInternals

// Regression test for WP #894 — the reported bug: every WS reconnect minted a
// fresh sessionId, so history + uploads were lost between turns. After the
// fix, a reconnect POSTs {resumeSessionId: <the minted id>} and the
// controller resumes the SAME session.
test('WP-894: reconnect after a WS drop resumes the same session (no churn)', async () => {
  const { startBodies, sockets } = useRecordingEnv()

  const t = new HarnessTransport({
    apiBase: '/chat',
    getProviderSelection: () => ({ provider: 'anthropic', model: 'claude' }),
  })

  await t.connect()
  // First /start has no resumeSessionId — the controller mints sess-1.
  expect(startBodies).toEqual([''])
  expect(t.getActiveSession()?.sessionId).toBe('sess-1')

  // Simulate the drop: sprite went cold / laptop slept / network blip.
  sockets[0]!.dispatch('close')
  expect(t.getActiveSession()).toBeNull()

  // The next connect lazily re-opens. It MUST resume sess-1, not mint fresh —
  // i.e. POST {resumeSessionId: 'sess-1'}. Pre-fix this posted '' → new session.
  await t.connect()
  expect(startBodies[1]).toBe(JSON.stringify({ resumeSessionId: 'sess-1' }))
  expect(t.getActiveSession()?.sessionId).toBe('sess-1')

  t.destroy()
})

// WP-894 keepalive: a quiet-but-live socket is probed with a ping; the
// harness's pong reply clears the outstanding ping (no spurious close).
test('WP-894 keepalive: idle socket is pinged; pong clears the probe', async () => {
  const { sockets } = useRecordingEnv()

  const t = new HarnessTransport({
    apiBase: '/chat',
    getProviderSelection: () => ({ provider: 'anthropic', model: 'claude' }),
  })
  // Tiny cadence — the assertions below call keepaliveTick directly, so the
  // interval value only gates the "is it idle?" comparison.
  watchdog(t).keepaliveIntervalMs = 10

  await t.connect()
  const ws = sockets.at(-1)!

  // Pretend the connection has been quiet past the idle threshold, then tick.
  watchdog(t).lastInboundAt = 0
  watchdog(t).keepaliveTick(ws as unknown as WebSocket)
  expect(ws.sent).toContainEqual({ type: 'ping' })
  expect(watchdog(t).pingSentAt).not.toBe(0)

  // Harness replies pong → outstanding ping is cleared, socket stays open.
  ws.dispatchMessage({ type: 'pong' })
  expect(watchdog(t).pingSentAt).toBe(0)
  expect(ws.readyState).toBe(1)

  t.destroy()
})

// WP-894 keepalive: actively-flowing traffic (streaming / tool I/O) suppresses
// the probe — a healthy turn must not generate ping noise.
test('WP-894 keepalive: active traffic suppresses the ping', async () => {
  const { sockets } = useRecordingEnv()

  const t = new HarnessTransport({
    apiBase: '/chat',
    getProviderSelection: () => ({ provider: 'anthropic', model: 'claude' }),
  })
  watchdog(t).keepaliveIntervalMs = 10

  await t.connect()
  const ws = sockets.at(-1)!

  // Connection is fresh (frames just flowed) — a tick must NOT send a ping.
  watchdog(t).lastInboundAt = Date.now()
  watchdog(t).keepaliveTick(ws as unknown as WebSocket)
  expect(ws.sent.find((m) => (m as { type?: string }).type === 'ping')).toBeUndefined()

  t.destroy()
})

// WP-894 keepalive: a ping that goes unanswered past the deadline means the
// socket is half-dead (the browser still reports OPEN but nothing flows).
// Force-close so onWsClose → reconnect → resume runs, instead of stranding
// the user's next message on a dead socket.
test('WP-894 keepalive: unanswered ping force-closes the half-dead socket', async () => {
  const { sockets } = useRecordingEnv()

  const t = new HarnessTransport({
    apiBase: '/chat',
    getProviderSelection: () => ({ provider: 'anthropic', model: 'claude' }),
  })
  watchdog(t).keepaliveIntervalMs = 10
  watchdog(t).keepaliveTimeoutMs = 30

  await t.connect()
  const ws = sockets.at(-1)!
  let closed = false
  ws.addEventListener('close', () => {
    closed = true
  })

  // Idle → first tick sends the ping.
  watchdog(t).lastInboundAt = 0
  watchdog(t).keepaliveTick(ws as unknown as WebSocket)
  expect(ws.sent).toContainEqual({ type: 'ping' })

  // No pong ever arrives. Age the outstanding ping past the deadline and tick
  // again → the watchdog force-closes (→ onWsClose → session cleared).
  watchdog(t).pingSentAt = 1 // simulate "sent a very long time ago"
  watchdog(t).keepaliveTick(ws as unknown as WebSocket)
  expect(closed).toBe(true)
  expect(t.getActiveSession()).toBeNull()

  t.destroy()
})
