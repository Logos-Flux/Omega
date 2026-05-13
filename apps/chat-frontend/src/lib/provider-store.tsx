import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { readWithLegacyKey } from './storage'

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

// Gemini 3.1 Pro Preview is split into two Google SKUs:
//   - `gemini-3.1-pro-preview`              — accepts googleSearch grounding, hangs on
//                                             any `functionDeclarations`
//   - `gemini-3.1-pro-preview-customtools`  — accepts custom function calls, rejects
//                                             googleSearch
// Until Google ships a unified Pro SKU (or we model-aware-pick), the Gemini Pro
// option is disabled in the UI — Flash supports both tool surfaces in one model.
export function isTierDisabled(provider: ProviderId, tier: Tier): boolean {
  return provider === 'google' && tier === 'advanced'
}

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

const STORAGE_KEY = 'omega.chat.provider'
const LEGACY_STORAGE_KEY = '52l.chat.provider'

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
    const raw = readWithLegacyKey(window.localStorage, STORAGE_KEY, LEGACY_STORAGE_KEY)
    if (!raw) return { provider: DEFAULT_PROVIDER, tier: DEFAULT_TIER }
    const parsed = JSON.parse(raw) as Partial<Selection>
    const provider = parsed.provider && parsed.provider in PROVIDERS ? parsed.provider : DEFAULT_PROVIDER
    const tier: Tier = parsed.tier === 'basic' || parsed.tier === 'advanced' ? parsed.tier : DEFAULT_TIER
    // Coerce away any disabled (provider, tier) pair so a stored Gemini Pro
    // selection from before this fix doesn't dead-end the next chat turn.
    if (isTierDisabled(provider, tier)) return { provider, tier: 'basic' }
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
    setSelection((prev) => {
      if (prev.provider === provider) return prev
      // If the incoming provider can't honour the current tier (e.g. Gemini Pro
      // is disabled), drop to basic so the resolved model is always valid.
      const tier = isTierDisabled(provider, prev.tier) ? 'basic' : prev.tier
      return { provider, tier }
    })
  }, [])

  const setTier = useCallback((tier: Tier) => {
    setSelection((prev) => {
      if (prev.tier === tier) return prev
      if (isTierDisabled(prev.provider, tier)) return prev
      return { ...prev, tier }
    })
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
