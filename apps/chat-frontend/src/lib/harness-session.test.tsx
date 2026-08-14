// Component tests for HarnessSessionProvider covering WP #895.
//
// Root cause A — uploadFiles had try/finally but no catch, so a thrown POST
// (sprite suspended/CORS/blocked) was swallowed by the `void uploadFiles(...)`
// call sites: "Uploading 1…" flipped back to "Add file" with no file and no
// error. The fix adds a catch that routes the error to uploadError and still
// resets the counter.
//
// Root cause B — the 1s poller closed over a stale `session` (deps [transport],
// exhaustive-deps disabled), so its dead-session clear-branch never fired. The
// fix feeds the poller the live session via a ref + nextSessionState. The
// decision table is pinned in harness-session.logic.test.ts; these tests pin
// the wiring: the poller adopts the transport's session on mount, and clears
// it when the transport later reports none.

import { afterAll, beforeAll, beforeEach, afterEach, test, expect } from 'bun:test'
import { Window } from 'happy-dom'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { HarnessSessionProvider, useHarnessSession } from './harness-session'
import type { HarnessTransport, HarnessPhase } from './harness-transport'

// ---- happy-dom environment (scoped to this file; restored after) ----------
let domCleanup: (() => void) | null = null

beforeAll(() => {
  // React 19 gates `act` effect-flushing on this flag.
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

  const win = new Window()
  const keys = new Set<string>([
    ...Object.getOwnPropertyNames(win),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(win)),
  ])
  // Only delete what we actually added on cleanup — happy-dom's Window also
  // carries JS builtins (Map, Set, …) that already exist on globalThis; the
  // copy loop skips those, so blanket-deleting `keys` would strip builtins
  // from the process and break every test file that runs after this one.
  const added: string[] = []
  for (const key of keys) {
    if (key === 'globalThis') continue
    if (!(key in globalThis)) {
      try {
        ;(globalThis as Record<string, unknown>)[key] = (
          win as unknown as Record<string, unknown>
        )[key]
        added.push(key)
      } catch {
        /* read-only global — skip */
      }
    }
  }
  for (const key of ['window', 'document']) {
    if (!added.includes(key) && !(key in globalThis)) added.push(key)
  }
  ;(globalThis as Record<string, unknown>).window = win
  ;(globalThis as Record<string, unknown>).document = win.document
  domCleanup = () => {
    for (const key of added) {
      try {
        delete (globalThis as Record<string, unknown>)[key]
      } catch {
        /* ignore */
      }
    }
  }
})

afterAll(() => domCleanup?.())

// ---- fetch stub -----------------------------------------------------------
const ORIGINAL_FETCH = globalThis.fetch

function stubFetch(opts: { postThrows?: Error; postStatus?: number } = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const url = typeof input === 'string' ? input : (input as Request).url ?? ''
    if (method === 'POST') {
      if (opts.postThrows) throw opts.postThrows
      const ok = !opts.postStatus || opts.postStatus < 400
      return { ok, status: opts.postStatus ?? 200, text: async () => '', json: async () => ({ uploads: [] }) } as unknown as Response
    }
    if (method === 'DELETE') {
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) } as unknown as Response
    }
    if (url.includes('/skills')) {
      return { ok: true, status: 200, json: async () => ({ skills: [] }) } as unknown as Response
    }
    // GET /uploads/<id>
    return { ok: true, status: 200, json: async () => ({ uploads: [] }) } as unknown as Response
  }) as typeof fetch
}

beforeEach(() => stubFetch())
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

// ---- mock transport -------------------------------------------------------
type Snap = { sessionId: string; token: string; container: { name: string; url: string; provider: string } }
function makeTransport(initial: Snap | null) {
  let active = initial
  const phase: HarnessPhase = { kind: 'idle' }
  return {
    __setActive(s: Snap | null) {
      active = s
    },
    connect: async () => {},
    getPhase: () => phase,
    subscribePhase: () => () => {},
    getActiveSession: () => active,
  } as unknown as HarnessTransport & { __setActive(s: Snap | null): void }
}

const snap = (id: string): Snap => ({
  sessionId: id,
  token: `tok-${id}`,
  container: { name: 'pi-spike-01', url: 'https://sprite.example', provider: 'sprites' },
})

// ---- harness --------------------------------------------------------------
interface ProbeHandle {
  ctx: ReturnType<typeof useHarnessSession>
}

async function render(transport: HarnessTransport | null) {
  const captured: ProbeHandle = { ctx: null as unknown as ReturnType<typeof useHarnessSession> }
  function Probe() {
    captured.ctx = useHarnessSession()
    return null
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  // async act flushes the mount-time fetch promises (refreshUploads /
  // skills effects) inside the act boundary so they don't warn.
  await act(async () => {
    root.render(h(HarnessSessionProvider, { transport, children: h(Probe) }))
  })
  return { captured, root, host }
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return pred()
}

// ---- tests ----------------------------------------------------------------

test('uploadFiles surfaces a thrown POST as uploadError and resets the counter (root cause A)', async () => {
  stubFetch({ postThrows: new Error('boom-CORS') })

  const transport = makeTransport(snap('sess-1'))
  const { captured, root } = await render(transport)

  // Poller adopted the transport's session on mount (tick() runs immediately).
  expect(captured.ctx.session?.sessionId).toBe('sess-1')
  expect(captured.ctx.uploadError).toBe(null)

  const file = new File(['payload'], 'a.txt', { type: 'text/plain' })
  await act(async () => {
    // Before the fix this rejected and was swallowed by `void uploadFiles(...)`;
    // now it resolves with the error surfaced.
    await captured.ctx.uploadFiles([file])
  })

  expect(captured.ctx.uploadError).toContain('upload failed')
  expect(captured.ctx.uploadError).toContain('boom-CORS')
  // finally {} still ran despite the throw — indicator must return to rest.
  expect(captured.ctx.uploadingCount).toBe(0)

  await act(async () => {
    root.unmount()
  })
})

test('uploadFiles surfaces a non-ok POST as uploadError (status path still works)', async () => {
  stubFetch({ postStatus: 413 })

  const transport = makeTransport(snap('sess-1'))
  const { captured, root } = await render(transport)
  expect(captured.ctx.session?.sessionId).toBe('sess-1')

  const file = new File(['payload'], 'big.bin', { type: 'application/octet-stream' })
  await act(async () => {
    await captured.ctx.uploadFiles([file])
  })

  expect(captured.ctx.uploadError).toContain('upload failed')
  expect(captured.ctx.uploadError).toContain('413')
  expect(captured.ctx.uploadingCount).toBe(0)

  await act(async () => {
    root.unmount()
  })
})

test('poller adopts the transport session on mount (root cause B wiring)', async () => {
  const transport = makeTransport(snap('sess-7'))
  const { captured, root } = await render(transport)
  // Pre-fix this also worked for adoption (the stale null satisfied the
  // adopt branch) — but pinning it guards the ref-based path going forward.
  expect(captured.ctx.session?.sessionId).toBe('sess-7')
  act(() => {
    root.unmount()
  })
})

test('poller clears a dead session when the transport reports none (root cause B)', async () => {
  const transport = makeTransport(snap('sess-1'))
  const { captured, root } = await render(transport)
  expect(captured.ctx.session?.sessionId).toBe('sess-1')

  // Sprite suspended / torn down: the transport now reports no session.
  transport.__setActive(null)

  // The 1s poller must now clear — previously the clear-branch was dead
  // code (stale null closure) and the dead session lingered.
  const cleared = await waitFor(() => captured.ctx.session === null, 2000)
  expect(cleared).toBe(true)
  expect(captured.ctx.session).toBe(null)

  await act(async () => {
    root.unmount()
  })
})
