// Quick-action cards rendered on the chat empty state.
//
// OSS Omega ships zero quick actions — the empty state just shows the
// "How can I help?" headline and the composer. Deployments that want
// to surface curated prompts (e.g., "Qualify Sales Leads", "Market
// Research Report") populate the array and provide an onSelect
// handler via this provider.
//
// Customization pattern: see docs/CUSTOMIZATION.md. The shape of every
// configurable surface in OSS is "empty default + Provider wrapper for
// data + optional handler". Operators pass in arrays/handlers without
// editing OSS code.

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from 'react'

export interface QuickAction {
  /** Stable id, used as React key + for analytics. */
  id: string
  /** Card title. Short, action-oriented ("Qualify Sales Leads"). */
  label: string
  /** One-line subtitle under the label. Optional. */
  description?: string
  /** Small ribbon in the corner of the card ("New", "Beta",
   *  "Coming soon"). Purely cosmetic. */
  badge?: string
  /** Optional navigation target. When present, the default onSelect
   *  handler routes the user here (same tab for same-origin, new tab
   *  otherwise). Operators can ignore this and supply their own
   *  onSelect for custom behavior (e.g. inserting the label as a
   *  composer prompt). */
  href?: string
}

export interface QuickActionsContextValue {
  actions: QuickAction[]
  /** Called when the user clicks a card. The default no-op is fine
   *  for OSS where there are no cards; deployments that ship cards
   *  should provide a real handler. */
  onSelect: (action: QuickAction) => void
}

const EMPTY: QuickActionsContextValue = {
  actions: [],
  onSelect: () => {},
}

const QuickActionsContext = createContext<QuickActionsContextValue>(EMPTY)

export interface QuickActionsProviderProps {
  children: ReactNode
  actions?: QuickAction[]
  onSelect?: (action: QuickAction) => void
}

export function QuickActionsProvider({
  children,
  actions = [],
  onSelect,
}: QuickActionsProviderProps) {
  const value = useMemo<QuickActionsContextValue>(
    () => ({
      actions,
      onSelect: onSelect ?? (() => {}),
    }),
    [actions, onSelect],
  )
  return (
    <QuickActionsContext.Provider value={value}>{children}</QuickActionsContext.Provider>
  )
}

export function useQuickActions(): QuickActionsContextValue {
  return useContext(QuickActionsContext)
}
