import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { useChatRuntime, AssistantChatTransport } from '@assistant-ui/react-ai-sdk'
import type { ChatTransport, UIMessage } from 'ai'
import { Thread } from './components/assistant-ui/thread'
import { AppShell, AuthProvider, UserMenu, useAuth } from '@omega-inc/app-shell'
import { SignInScreen } from './components/SignInScreen'
import { ChatDrawer } from './components/ChatDrawer'
import { AgentModeBanner } from './components/AgentModeBanner'
import { AgentActivityIndicator } from './components/AgentActivityIndicator'
import { AgentActivityPanel } from './components/AgentActivityPanel'
import { ProviderSelectionProvider, tierForModel, useProviderSelection, type ProviderId } from './lib/provider-store'
import { AgentModeProvider, useAgentMode } from './lib/agent-mode'
import { HarnessTransport } from './lib/harness-transport'
import { HarnessSessionProvider } from './lib/harness-session'
import { ThreadLockProvider, useThreadLock } from './lib/thread-lock'
import { SettingsPage, isSettingsPath } from './components/SettingsPage'
import { SpriteWarmupProvider } from './lib/sprite-warmup'
import { SpriteWarmupBanner } from './components/SpriteWarmupBanner'

const API_BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '')

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
    <AuthProvider>
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

  // Google OAuth gating is opt-in — re-add <GoogleConnectGate> wrapper here
  // when running with ENABLE_GOOGLE_OAUTH=true on the controller. The
  // `lib/google-oauth.tsx` hook + ConnectGoogleScreen components remain
  // available; just wire them back into this tree.
  //
  // Sprite warmup fires immediately after auth resolves so the per-user
  // sprite is provisioned (or unfrozen from checkpoint) in the background
  // while the user is landing on the chat surface. Banner mounts inside
  // the chat surface; AgentModeProvider reads the warmup state via context
  // (via useSpriteWarmup) to mask agent mode while the sprite isn't ready.
  return (
    <SpriteWarmupProvider enabled={true} apiBase={API_BASE}>
      {settings ? (
        <SettingsPage />
      ) : (
        <AgentModeProvider>
          <ProviderSelectionProvider>
            <ThreadLockProvider>
              <ChatPage />
            </ThreadLockProvider>
          </ProviderSelectionProvider>
        </AgentModeProvider>
      )}
    </SpriteWarmupProvider>
  )
}

interface ThreadState {
  id: string
  messages: UIMessage[]
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
    // The threads list is a chat-api concept — in agent mode it'd be
    // empty (harness threads live in /workspace/conversations/) and the
    // 401-by-design probe would be noisy. Skip the call.
    if (agentMode) return
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
        // No thread API in agent mode; just reset to a fresh shell.
        setState({ id: crypto.randomUUID(), messages: [] })
        threadLock.clear()
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
      <ChatPageInner
        key={`${agentMode ? 'agent' : 'api'}-${state.id}`}
        threadId={state.id}
        initialMessages={state.messages}
      />
    </ThreadNavContext.Provider>
  )
}

function ChatPageInner({
  threadId,
  initialMessages,
}: {
  threadId: string
  initialMessages: UIMessage[]
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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <HarnessSessionProvider transport={harnessTransport}>
        <AppShell
          appId="chat"
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
          <div className="flex h-full">
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
            {agentMode && <AgentActivityPanel />}
          </div>
        </AppShell>
      </HarnessSessionProvider>
    </AssistantRuntimeProvider>
  )
}
