import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

export type ProviderId = 'anthropic' | 'google' | 'perplexity'
export type Tier = 'basic' | 'advanced'

export const PROVIDERS: Record<
  ProviderId,
  { label: string; models: Record<Tier, string> }
> = {
  anthropic: {
    label: 'Anthropic',
    models: { basic: 'claude-sonnet-4-6', advanced: 'claude-opus-4-7' },
  },
  google: {
    label: 'Gemini',
    models: { basic: 'gemini-3-flash-preview', advanced: 'gemini-3.1-pro-preview' },
  },
  perplexity: {
    label: 'Perplexity',
    models: { basic: 'sonar', advanced: 'sonar-pro' },
  },
}

export const DEFAULT_PROVIDER: ProviderId = 'perplexity'
export const DEFAULT_TIER: Tier = 'advanced'

/**
 * Inverse of `PROVIDERS[provider].models[tier]`. Returns null if the
 * model isn't one of the recognised pair members for this provider.
 * Used by I.D.2 to project a locked (provider, model) coming from
 * chat-api back onto the (provider, tier) the bar's UI uses.
 */
export function tierForModel(provider: ProviderId, model: string): Tier | null {
  const models = PROVIDERS[provider].models
  if (models.basic === model) return 'basic'
  if (models.advanced === model) return 'advanced'
  return null
}

const STORAGE_KEY = '52l.chat.provider'

interface Selection {
  provider: ProviderId
  tier: Tier
}

interface SelectionContextValue extends Selection {
  model: string
  setProvider: (p: ProviderId) => void
  setTier: (t: Tier) => void
}

function readStoredSelection(): Selection {
  if (typeof window === 'undefined') return { provider: DEFAULT_PROVIDER, tier: DEFAULT_TIER }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { provider: DEFAULT_PROVIDER, tier: DEFAULT_TIER }
    const parsed = JSON.parse(raw) as Partial<Selection>
    const provider = parsed.provider && parsed.provider in PROVIDERS ? parsed.provider : DEFAULT_PROVIDER
    const tier: Tier = parsed.tier === 'basic' || parsed.tier === 'advanced' ? parsed.tier : DEFAULT_TIER
    return { provider, tier }
  } catch {
    return { provider: DEFAULT_PROVIDER, tier: DEFAULT_TIER }
  }
}

const ProviderSelectionContext = createContext<SelectionContextValue | null>(null)

export function ProviderSelectionProvider({ children }: { children: React.ReactNode }) {
  const [selection, setSelection] = useState<Selection>(() => readStoredSelection())

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection))
    } catch {
      // ignore
    }
  }, [selection])

  const setProvider = useCallback((provider: ProviderId) => {
    setSelection((prev) => (prev.provider === provider ? prev : { ...prev, provider }))
  }, [])

  const setTier = useCallback((tier: Tier) => {
    setSelection((prev) => (prev.tier === tier ? prev : { ...prev, tier }))
  }, [])

  const value = useMemo<SelectionContextValue>(
    () => ({
      ...selection,
      model: PROVIDERS[selection.provider].models[selection.tier],
      setProvider,
      setTier,
    }),
    [selection, setProvider, setTier],
  )

  return <ProviderSelectionContext.Provider value={value}>{children}</ProviderSelectionContext.Provider>
}

export function useProviderSelection(): SelectionContextValue {
  const ctx = useContext(ProviderSelectionContext)
  if (!ctx) throw new Error('useProviderSelection must be used inside <ProviderSelectionProvider>')
  return ctx
}
