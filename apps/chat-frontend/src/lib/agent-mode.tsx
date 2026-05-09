import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useSpriteWarmup } from './sprite-warmup'
import { readWithLegacyKey } from './storage'

// Agent Mode = the harness-backed runtime (Pi-harness inside a Sprite).
// Toggle ON (default) routes through the harness transport; OFF falls back
// to chat-api. Default is ON because operators pre-provision per-user
// sprites before the user signs in (scripts/provision-user.ts) — the
// warmup hits the existing-row fast path on every sign-in, so there's no
// cold-start cost to landing in agent mode on first paint. Persisted in
// localStorage so a user's pick survives reloads.
//
// Effective agentMode is masked to false whenever the sprite warmup state
// isn't 'ready'. Without this mask, a returning user whose localStorage has
// agentMode=true would land on the chat surface with the harness transport
// constructed against an unprovisioned sprite — every message they send
// would silently fail (WS to a dead URL or /start hanging on bootstrap).
// The persisted preference is preserved; the moment warmup flips ready,
// agent mode comes back on automatically. So even with the default flipped
// to ON, an unprovisioned user (or one mid-bootstrap) can still chat via
// chat-api while the sprite is being prepared.

const STORAGE_KEY = 'omega.chat.agentMode'
// Legacy key for the v0.5.0 namespace rename. Migrated on first read so a
// user who explicitly toggled agent mode OFF in a prior 52l.chat.* build
// keeps that preference instead of being silently flipped back to the ON
// default after the rename. Idempotent — see lib/storage.ts.
const LEGACY_STORAGE_KEY = '52l.chat.agentMode'
const DEFAULT_AGENT_MODE = true

interface AgentModeContextValue {
  agentMode: boolean
  setAgentMode: (on: boolean) => void
  toggleAgentMode: () => void
}

function readStored(): boolean {
  if (typeof window === 'undefined') return DEFAULT_AGENT_MODE
  try {
    const raw = readWithLegacyKey(window.localStorage, STORAGE_KEY, LEGACY_STORAGE_KEY)
    if (raw === null) return DEFAULT_AGENT_MODE
    return raw === 'true'
  } catch {
    return DEFAULT_AGENT_MODE
  }
}

const AgentModeContext = createContext<AgentModeContextValue | null>(null)

export function AgentModeProvider({ children }: { children: React.ReactNode }) {
  const [persisted, setPersisted] = useState<boolean>(() => readStored())
  const { state: warmup } = useSpriteWarmup()

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(persisted))
    } catch {
      // ignore
    }
  }, [persisted])

  const setAgentMode = useCallback((on: boolean) => setPersisted(on), [])
  const toggleAgentMode = useCallback(() => setPersisted((prev) => !prev), [])

  // Mask the persisted preference until the sprite is actually usable.
  // While provisioning/failed/idle, the harness transport would just spin.
  const agentMode = persisted && warmup.kind === 'ready'

  const value = useMemo<AgentModeContextValue>(
    () => ({ agentMode, setAgentMode, toggleAgentMode }),
    [agentMode, setAgentMode, toggleAgentMode],
  )

  return <AgentModeContext.Provider value={value}>{children}</AgentModeContext.Provider>
}

export function useAgentMode(): AgentModeContextValue {
  const ctx = useContext(AgentModeContext)
  if (!ctx) throw new Error('useAgentMode must be used inside <AgentModeProvider>')
  return ctx
}
