import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AssistantRuntimeProvider, type AssistantRuntime } from '@assistant-ui/react'
import { useChatRuntime, AssistantChatTransport } from '@assistant-ui/react-ai-sdk'
import type { ChatTransport, UIMessage } from 'ai'
import { Thread } from './components/assistant-ui/thread'
import { ChatErrorBoundary } from './components/ChatErrorBoundary'
import { AppShell, AuthProvider, UserMenu, useAuth, type SessionUser } from '@omega-inc/app-shell'
import { SignInScreen } from './components/SignInScreen'
import { ChatDrawer } from './components/ChatDrawer'
import { AgentModeBanner } from './components/AgentModeBanner'
import { AgentActivityIndicator } from './components/AgentActivityIndicator'
// PERF-03 — agent-only panel; deferred until Agent Mode is on (also defers its
// FilesystemPane/RAGSourceCard subtree out of the entry chunk).
const AgentActivityPanel = lazy(() =>
  import('./components/AgentActivityPanel').then((m) => ({ default: m.AgentActivityPanel })),
)
import { ChatDropZone } from './components/ChatDropZone'
import { ProviderSelectionProvider, tierForModel, useProviderSelection, type ProviderId } from './lib/provider-store'
import { AgentModeProvider, useAgentMode } from './lib/agent-mode'
import { HarnessTransport } from './lib/harness-transport'
import { HarnessSessionProvider } from './lib/harness-session'
import {
  listAgentSessions,
  loadAgentSession,
  type ConversationLine,
} from './lib/harness-api'
import { QuickActionsProvider, type QuickAction } from './lib/quick-actions'
import { brand } from './lib/brand'
import { ThreadLockProvider, useThreadLock } from './lib/thread-lock'
// PERF-03 — SettingsPage is a large, rarely-hit route; lazy-load it. The cheap
// path check lives in ./lib/settings-path so routing costs nothing at boot.
const SettingsPage = lazy(() =>
  import('./components/SettingsPage').then((m) => ({ default: m.SettingsPage })),
)
import { isSettingsPath } from './lib/settings-path'
import { SpriteWarmupProvider } from './lib/sprite-warmup'
import { SpriteWarmupBanner } from './components/SpriteWarmupBanner'
import { GoogleOAuthProvider, useGoogleOAuth } from './lib/google-oauth'
import {
  ConnectGoogleScreen,
  GoogleStatusLoading,
  GoogleStatusError,
  ReconnectGoogleBanner,
  ReconnectGoogleModal,
} from './components/ConnectGoogleScreen'

const API_BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '')

// Minimal fallback for lazy routes (PERF-03). Bare on purpose — the lazy
// chunks load in well under a frame on a warm cache; a spinner would flash.
function LazyFallback() {
  return <div className="grid min-h-[40vh] place-items-center text-t-muted text-sm">Loading…</div>
}

// Auth-plumbing envs forwarded to <AuthProvider>. Empty / unset gives the
// OSS default behavior (same-origin /api/me, no CF Access logout, no fake
// user). Operators set these at build time per docs/CUSTOMIZATION.md.
//
//   VITE_API_BASE              — explicit URL prefix for /api/me; useful
//                                when SPA mount path differs from API
//                                mount path (e.g. SPA at /chat/, API at
//                                /api/). Empty string = same-origin, no
//                                prefix. Unset falls back to BASE_URL.
//   VITE_CF_ACCESS_TEAM_DOMAIN — Cloudflare Access team domain; signOut()
//                                hits its /cdn-cgi/access/logout.
//   VITE_DEV_FAKE_USER         — JSON-encoded SessionUser for local dev
//                                without a controller. Honored only in
//                                dev builds (import.meta.env.DEV).
const RAW_VITE_API_BASE = import.meta.env.VITE_API_BASE as string | undefined
const AUTH_API_BASE =
  RAW_VITE_API_BASE !== undefined ? RAW_VITE_API_BASE.replace(/\/$/, '') : API_BASE
const CF_ACCESS_TEAM_DOMAIN =
  (import.meta.env.VITE_CF_ACCESS_TEAM_DOMAIN as string | undefined)?.trim() || undefined

// Google OAuth onboarding gate. Unset / not "true" → app renders ungated (OSS
// default). Operators set VITE_ENABLE_GOOGLE_GATE=true at build time so users are
// prompted to connect Drive / Gmail / Calendar before reaching the chat
// surface. The screen + status hook already exist (ConnectGoogleScreen,
// lib/google-oauth.tsx); the controller must also run ENABLE_GOOGLE_OAUTH=true
// for the /oauth/google/health probe behind <GoogleConnectGate> to work.
const ENABLE_GOOGLE_GATE =
  (import.meta.env.VITE_ENABLE_GOOGLE_GATE as string | undefined)?.trim() === 'true'

function readDevFakeUser(): SessionUser | undefined {
  if (!import.meta.env.DEV) return undefined
  const raw = (import.meta.env.VITE_DEV_FAKE_USER as string | undefined)?.trim()
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as SessionUser
  } catch (err) {
    console.warn('[chat-frontend] VITE_DEV_FAKE_USER set but not valid JSON; ignoring', err)
    return undefined
  }
}
const DEV_FAKE_USER = readDevFakeUser()

// Onboarding gate: blocks the app behind the Google consent screen until the
// controller's /oauth/google/health probe reports a working grant. Must render
// inside <GoogleOAuthProvider>. Mounted only when ENABLE_GOOGLE_GATE is set —
// see the wrapped return in <AppShellRouter>. transient / misconfigured surface as the
// retry screen (handled inside the hook → state.kind === 'error').
function GoogleConnectGate({ children }: { children: ReactNode }) {
  const { state, skipped, needsReconsent, refresh } = useGoogleOAuth()
  // Whether the user declined the can't-miss reconnect MODAL. Declining doesn't
  // clear the reminder — it falls back to the persistent (non-dismissible) banner.
  const [reconsentModalDeclined, setReconsentModalDeclined] = useState(false)
  if (state.kind === 'loading') return <GoogleStatusLoading />
  if (state.kind === 'error') {
    return <GoogleStatusError message={state.message} onRetry={() => void refresh()} />
  }
  if (!state.connected && !skipped) return <ConnectGoogleScreen />
  // Connected but on an older grant missing a now-required scope. A top banner
  // was too easy to miss, so first show a blocking modal (reconnect or decline);
  // on decline a persistent banner stays at the top until they reconnect.
  return (
    <>
      {needsReconsent && reconsentModalDeclined && <ReconnectGoogleBanner />}
      {children}
      {needsReconsent && !reconsentModalDeclined && (
        <ReconnectGoogleModal onDecline={() => setReconsentModalDeclined(true)} />
      )}
    </>
  )
}

// Quick-action cards rendered on the chat empty state. Cards with
// `href` navigate; cards without it are informational (the default
// onSelect is a no-op so the click feels intentional but doesn't move
// the user away from the chat surface).
// Operators customize this array for their own deployment. Cards with an
// `href` navigate (same-origin → in-place, cross-origin → new tab); cards
// without one are informational. The default ships a single generic card
// pointing at Agent Mode — replace or extend it with your own quick actions.
const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'agent-mode',
    label: 'Agent Mode',
    description: 'Use skills, review uploads, and access the full index of your documents in agent mode.',
  },
]

function handleQuickAction(action: QuickAction): void {
  if (!action.href) return
  if (typeof window === 'undefined') return
  try {
    const target = new URL(action.href, window.location.href)
    if (target.origin === window.location.origin) {
      window.location.assign(target.href)
    } else {
      window.open(target.href, '_blank', 'noopener,noreferrer')
    }
  } catch {
    window.location.assign(action.href)
  }
}

export interface ThreadInfo {
  id: string
  title: string | null
  updated_at: string
  // I.D — null until the first turn of the thread locks it. Surfaced in the
  // drawer so the user can see what each thread is pinned to.
  provider?: string | null
  model?: string | null
}

interface ThreadNavValue {
  activeThreadId: string
  threads: ThreadInfo[]
  selectThread: (id: string) => void
  newThread: () => void
  refresh: () => void
}

const ThreadNavContext = createContext<ThreadNavValue | null>(null)

export function useThreadNav(): ThreadNavValue {
  const ctx = useContext(ThreadNavContext)
  if (!ctx) throw new Error('useThreadNav must be used inside <ThreadNavContext.Provider>')
  return ctx
}

// The OSS shell stub always returns `status: 'authenticated'`. Operators
// add their own auth at the reverse-proxy layer (oauth2-proxy, Caddy basic
// auth, Tailscale serve, etc.); see packages/shell/src/AuthProvider.tsx.
export function App() {
  return (
    <AuthProvider
      apiBase={AUTH_API_BASE}
      cfAccessTeamDomain={CF_ACCESS_TEAM_DOMAIN}
      fakeUser={DEV_FAKE_USER}
    >
      <AppShellRouter />
    </AuthProvider>
  )
}

function AppShellRouter() {
  const { status } = useAuth()

  // Path-based routing: there's no react-router — the SPA toggles
  // between the chat surface and the settings page on `pathname`.
  // `useState` with a window listener so `<a href="/chat/settings">`
  // works with normal browser navigation. Pushed-state changes from
  // inside the SPA (e.g. a future "settings → chat" link) need to fire
  // a `popstate`-equivalent — we listen for both.
  const [path, setPath] = useState<string>(() =>
    typeof window === 'undefined' ? '' : window.location.pathname,
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onPopState = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // Phase-1 retire: `/chat/demo` is gone — Agent Mode now lives at
  // `/chat/` with a toggle in the provider bar. Old bookmarks land here
  // and get redirected. Replace (not push) so the demo URL doesn't sit
  // in browser history.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const base = import.meta.env.BASE_URL
    const p = window.location.pathname
    if (p === `${base}demo` || p.startsWith(`${base}demo/`)) {
      window.history.replaceState({}, '', base)
      setPath(base)
    }
  }, [])

  if (status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-t-deep">
        <span className="text-xs font-terminal uppercase tracking-wider text-t-muted">
          Loading session…
        </span>
      </main>
    )
  }
  if (status === 'anonymous') return <SignInScreen />

  // `path` participates in the dependency: re-renders triggered by
  // popstate or pushState are what swap the page. Reading it here avoids
  // the unused-locals lint and keeps the routing decision in one spot.
  const settings = path ? path.startsWith(import.meta.env.BASE_URL + 'settings') : isSettingsPath()

  // Sprite warmup fires immediately after auth resolves so the per-user
  // sprite is provisioned (or unfrozen from checkpoint) in the background
  // while the user is landing on the chat surface. Banner mounts inside
  // the chat surface; AgentModeProvider reads the warmup state via context
  // (via useSpriteWarmup) to mask agent mode while the sprite isn't ready.
  const appTree = (
    <SpriteWarmupProvider enabled={true} apiBase={API_BASE}>
      {settings ? (
        <Suspense fallback={<LazyFallback />}>
          <SettingsPage />
        </Suspense>
      ) : (
        <AgentModeProvider>
          <ProviderSelectionProvider>
            <ThreadLockProvider>
              {/* Quick-action cards on the chat empty state. OSS ships
                  no actions — operators populate via this provider's
                  `actions` + `onSelect` props. See docs/CUSTOMIZATION.md. */}
              <QuickActionsProvider actions={QUICK_ACTIONS} onSelect={handleQuickAction}>
                <ChatPage />
              </QuickActionsProvider>
            </ThreadLockProvider>
          </ProviderSelectionProvider>
        </AgentModeProvider>
      )}
    </SpriteWarmupProvider>
  )

  // Google OAuth onboarding gate (opt-in via VITE_ENABLE_GOOGLE_GATE). When on,
  // the consent screen blocks the app until the user has a working Google grant;
  // when off, render the app ungated (OSS default).
  if (!ENABLE_GOOGLE_GATE) return appTree
  return (
    <GoogleOAuthProvider>
      <GoogleConnectGate>{appTree}</GoogleConnectGate>
    </GoogleOAuthProvider>
  )
}

interface ThreadState {
  id: string
  messages: UIMessage[]
  // Agent mode only: when set, the harness transport resumes this past session
  // (controller mints a token scoped to it) instead of starting a fresh one.
  resumeSessionId?: string
}

// Map a harness conversation (jsonl lines) into assistant-ui UIMessages so a
// resumed agent thread renders its history. One text part per line.
//
// IDs MUST be unique per message. assistant-ui keys its MessageRepository by
// message id and THROWS ("a message with the same id already exists in the
// parent tree") if the same id appears twice in a thread — an uncaught render
// error that white-screens the whole app (no error boundary). The harness
// writes a turn's user AND assistant lines with the SAME frame id (engine.ts —
// it's the rewind anchor), so a resumed conversation always has duplicate ids.
// Suffix with the line index to guarantee uniqueness. Safe: the frame id is
// never used client-side (sends mint a fresh turnId in HarnessTransport), so
// the UI id is purely a render key.
export function linesToUIMessages(lines: ConversationLine[]): UIMessage[] {
  return lines.map(
    (l, i) =>
      ({
        id: `${l.id ?? 'hist'}-${i}`,
        role: l.role,
        parts: [{ type: 'text', text: l.text }],
      }) as UIMessage,
  )
}

// Single chat surface — the assistant-ui <Thread /> backed by either
// chat-api (HTTP streaming) or the Pi harness (WebSocket). The transport
// swap lives in <ChatPageInner>; everything outside is mode-agnostic.
function ChatPage() {
  const [state, setState] = useState<ThreadState>(() => ({
    id: crypto.randomUUID(),
    messages: [],
  }))
  const [threads, setThreads] = useState<ThreadInfo[]>([])
  const { agentMode } = useAgentMode()
  const threadLock = useThreadLock()
  const { setProvider, setTier } = useProviderSelection()

  const refresh = useCallback(async () => {
    if (agentMode) {
      // Agent threads live as jsonl on the sprite; list them via the harness.
      try {
        const sessions = await listAgentSessions()
        setThreads(
          sessions.map((s) => ({ id: s.id, title: s.title, updated_at: s.updatedAt })),
        )
      } catch {
        // harness not ready yet (provisioning) — leave the list as-is.
      }
      return
    }
    try {
      const res = await fetch(`${API_BASE}/api/threads`, { credentials: 'include' })
      if (!res.ok) return
      const data = (await res.json()) as { threads: ThreadInfo[] }
      setThreads(data.threads ?? [])
    } catch {
      // ignore
    }
  }, [agentMode])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

  const selectThread = useCallback(
    async (id: string) => {
      if (agentMode) {
        // Resume a past agent session: load its jsonl history for display and
        // set resumeSessionId so the remounted transport reconnects scoped to
        // it (controller validates ownership + mints a token for that session).
        // state.id := the session id so the ChatPageInner key changes → clean
        // remount with the resumed transport + the loaded history.
        threadLock.clear()
        try {
          const lines = await loadAgentSession(id)
          setState({ id, messages: linesToUIMessages(lines), resumeSessionId: id })
        } catch {
          // Couldn't load history — still resume the session; it'll stream live.
          setState({ id, messages: [], resumeSessionId: id })
        }
        return
      }
      try {
        const res = await fetch(`${API_BASE}/api/threads/${id}`, { credentials: 'include' })
        if (!res.ok) {
          setState({ id, messages: [] })
          threadLock.clear()
          return
        }
        const data = (await res.json()) as {
          thread?: { provider?: string | null; model?: string | null }
          messages?: Array<{ content: UIMessage }>
        }
        const messages = (data.messages ?? []).map((row) => row.content)
        setState({ id, messages })
        // Hydrate the lock from the row. Also nudge the provider bar to the
        // locked pair so the user sees the same selection that's actually
        // pinned, rather than whatever they last picked.
        const lockedProvider = data.thread?.provider ?? null
        const lockedModel = data.thread?.model ?? null
        threadLock.setLock({ provider: lockedProvider, model: lockedModel })
        if (lockedProvider && lockedModel) {
          const p = lockedProvider as ProviderId
          const tier = tierForModel(p, lockedModel)
          setProvider(p)
          if (tier) setTier(tier)
        }
      } catch {
        setState({ id, messages: [] })
        threadLock.clear()
      }
    },
    [agentMode, threadLock, setProvider, setTier],
  )

  const newThread = useCallback(() => {
    setState({ id: crypto.randomUUID(), messages: [] })
    // Brand-new thread starts unlocked; the next /api/chat response will
    // populate the lock from response headers once the first turn lands.
    threadLock.clear()
  }, [threadLock])

  // Force a fresh thread shell whenever Agent Mode flips *after* mount.
  // The transport also gets re-created (see ChatPageInner), but
  // resetting the thread id means we don't try to replay chat-api
  // messages over the harness (or vice versa) and the assistant-ui
  // state machine starts clean. We skip the initial run so we don't
  // throw away the threadId we just minted in `useState`'s initialiser.
  const didMountRef = useRef(false)
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    setState({ id: crypto.randomUUID(), messages: [] })
  }, [agentMode])

  const nav = useMemo<ThreadNavValue>(
    () => ({ activeThreadId: state.id, threads, selectThread, newThread, refresh }),
    [state.id, threads, selectThread, newThread, refresh],
  )

  return (
    <ThreadNavContext.Provider value={nav}>
      {/* Re-mount the inner runtime when either the thread id changes or
          Agent Mode toggles. The transport instance differs in each
          case, and useChatRuntime's internal state is keyed off the
          first transport it sees, so a clean remount is the simplest
          way to avoid mid-stream protocol mismatches. */}
      <ChatErrorBoundary resetKey={state.id} onReset={newThread}>
        <ChatPageInner
          key={`${agentMode ? 'agent' : 'api'}-${state.id}`}
          threadId={state.id}
          initialMessages={state.messages}
          resumeSessionId={state.resumeSessionId}
        />
      </ChatErrorBoundary>
    </ThreadNavContext.Provider>
  )
}

function ChatPageInner({
  threadId,
  initialMessages,
  resumeSessionId,
}: {
  threadId: string
  initialMessages: UIMessage[]
  resumeSessionId?: string
}) {
  const { provider, model } = useProviderSelection()
  const selectionRef = useRef({ provider, model })
  selectionRef.current = { provider, model }
  const { refresh } = useThreadNav()
  const { agentMode } = useAgentMode()
  const threadLock = useThreadLock()
  // Hold the latest setter / reader in a ref so the transport's fetch
  // wrapper (constructed once at mount) sees fresh values without us
  // having to rebuild the transport on every selection change.
  const lockRef = useRef(threadLock)
  lockRef.current = threadLock

  // Build the right transport for the current mode. The `key` on
  // <ChatPageInner> ensures we only construct one transport per mount,
  // so no useMemo deps gymnastics — useState's initializer is the
  // simplest stable construction.
  const [{ transport, harnessTransport }] = useState(() => {
    if (agentMode) {
      const t = new HarnessTransport({
        apiBase: API_BASE,
        getProviderSelection: () => selectionRef.current,
        resumeSessionId,
      })
      return { transport: t as ChatTransport<UIMessage>, harnessTransport: t }
    }
    const t = new AssistantChatTransport({
      api: `${API_BASE}/api/chat`,
      credentials: 'include',
      // I.D.2 — when the user is sending a turn whose (provider, model)
      // pair differs from the thread's current lock, treat the click on
      // Send as an explicit acknowledgement of "yes, switch this thread
      // and pay the cache-fill cost". The chat-api will re-lock to the
      // new pair.
      body: () => {
        const sel = selectionRef.current
        const lock = lockRef.current.readLock()
        const isMismatch =
          lock.provider !== null &&
          lock.model !== null &&
          (lock.provider !== sel.provider || lock.model !== sel.model)
        return { ...sel, ...(isMismatch ? { override: true } : {}) }
      },
      // Wrap fetch so we can hydrate the thread-lock from the response
      // headers (X-Locked-Provider / X-Locked-Model / X-Lock-Mismatched).
      // The headers are set on every /api/chat response — including the
      // first turn, which is when the row is created server-side.
      // The cast is because `typeof fetch` carries Bun-specific extras
      // (preconnect) that a wrapping arrow function can't satisfy.
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await fetch(input, init)
        const lp = res.headers.get('X-Locked-Provider')
        const lm = res.headers.get('X-Locked-Model')
        if (lp && lm) {
          lockRef.current.setLock({ provider: lp, model: lm })
        }
        return res
      }) as unknown as typeof fetch,
    })
    return { transport: t as ChatTransport<UIMessage>, harnessTransport: null }
  })

  // Tear down the harness WS when this inner unmounts (mode toggle or
  // page unload). chat-api transport has no resources to free.
  useEffect(() => {
    return () => {
      harnessTransport?.destroy()
    }
  }, [harnessTransport])

  const runtime = useChatRuntime({
    id: threadId,
    messages: initialMessages,
    transport,
    onFinish: () => {
      refresh()
    },
  })

  // useChatRuntime (react-ai-sdk@1.3) and AssistantRuntimeProvider
  // (@assistant-ui/react@0.12) disagree on the AssistantRuntime shape — a
  // packaging-version artifact, not a runtime incompatibility (prod runs this
  // fine; `bun build` skips typecheck). Cast at the seam so the project
  // typechecks (and the CI preflight can gate it). Reconcile by aligning the
  // two @assistant-ui versions.
  return (
    <AssistantRuntimeProvider runtime={runtime as unknown as AssistantRuntime}>

      <HarnessSessionProvider transport={harnessTransport}>
        <AppShell
          appId="chat"
          brandText={brand.name}
          brandHref={import.meta.env.BASE_URL}
          navConfigUrl={import.meta.env.VITE_NAV_CONFIG_URL || undefined}
          drawer={<ChatDrawer />}
          topNavEndSlot={
            <UserMenu
              settingsHref={`${import.meta.env.BASE_URL}settings`}
              onSettings={() => {
                // SPA navigation — pushState then dispatch popstate so
                // <AppShellRouter> picks up the path change without a
                // full page reload (which would tear down the harness
                // session and the agent-mode WS).
                const url = `${import.meta.env.BASE_URL}settings`
                window.history.pushState({}, '', url)
                window.dispatchEvent(new PopStateEvent('popstate'))
              }}
            />
          }
        >
          <ChatDropZone>
            <div className="flex min-w-0 flex-1 flex-col bg-t-deep">
              {/* Sprite warmup signal — visible regardless of agent mode so
                  users know the provisioning is running in the background
                  and don't toggle agent on prematurely. */}
              <SpriteWarmupBanner />
              {agentMode && <AgentModeBanner />}
              {agentMode && <AgentActivityIndicator />}
              <div className="min-h-0 flex-1">
                <Thread />
              </div>
            </div>
            {/* Right-side Activity feed — only in agent mode, collapsible. */}
            {agentMode && (
              <Suspense fallback={null}>
                <AgentActivityPanel />
              </Suspense>
            )}
          </ChatDropZone>
        </AppShell>
      </HarnessSessionProvider>
    </AssistantRuntimeProvider>
  )
}
