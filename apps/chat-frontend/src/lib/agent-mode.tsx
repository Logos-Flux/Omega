import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useSpriteWarmup } from './sprite-warmup'

// Agent Mode = the harness-backed runtime (Pi-harness inside a Sprite).
// Toggle OFF (default) routes through chat-api; ON constructs the harness
// transport which lazily provisions a per-user sprite on first send. We
// default OFF so a fresh sign-in doesn't pay the cold-start sprite cost
// before the user has decided they need agent capabilities. Persisted in
// localStorage so a user's pick survives reloads.
//
// Effective agentMode is masked to false whenever the sprite warmup state
// isn't 'ready'. Without this mask, a returning user whose localStorage has
// agentMode=true would land on the chat surface with the harness transport
// constructed against an unprovisioned sprite — every message they send
// would silently fail (WS to a dead URL or /start hanging on bootstrap).
// The persisted preference is preserved; the moment warmup flips ready,
// agent mode comes back on automatically.

const STORAGE_KEY = 'omega.chat.agentMode'
const DEFAULT_AGENT_MODE = false

interface AgentModeContextValue {
  agentMode: boolean
  setAgentMode: (on: boolean) => void
  toggleAgentMode: () => void
}

function readStored(): boolean {
  if (typeof window === 'undefined') return DEFAULT_AGENT_MODE
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
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
