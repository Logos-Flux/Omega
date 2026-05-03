import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

// Agent Mode = the harness-backed runtime (Pi-harness inside a Sprite),
// formerly only reachable via /chat/demo. Toggle ON (default) routes the
// chat through the harness; OFF falls back to the chat-api runtime that
// powers the regular `/chat/`. Persisted in localStorage so a user's pick
// survives reloads.

const STORAGE_KEY = '52l.chat.agentMode'
const DEFAULT_AGENT_MODE = true

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
  const [agentMode, setAgentModeState] = useState<boolean>(() => readStored())

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(agentMode))
    } catch {
      // ignore
    }
  }, [agentMode])

  const setAgentMode = useCallback((on: boolean) => setAgentModeState(on), [])
  const toggleAgentMode = useCallback(() => setAgentModeState((prev) => !prev), [])

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
