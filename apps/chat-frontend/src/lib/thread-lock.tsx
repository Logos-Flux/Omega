/**
 * I.D.2 — frontend side of per-thread provider lock-in.
 *
 * The chat-api persists `provider` + `model` on the thread row once the
 * first turn lands. This context tracks the currently-active thread's
 * lock so the `<ProviderBar />` can render a "switching invalidates
 * cache" indicator when the user selects a provider/model pair that
 * disagrees with the lock.
 *
 * Sources of truth (all flow into here):
 *  - `/api/threads/:id` GET — populates the lock when a thread is opened.
 *  - `X-Locked-Provider` / `X-Locked-Model` / `X-Lock-Mismatched` response
 *    headers on `/api/chat` — refreshed on every send via a custom fetch
 *    wrapper on the AI SDK transport (see `App.tsx`).
 *  - `setLocal` — for the brand-new-thread case where the row doesn't
 *    exist server-side yet but the user just clicked
 *    "Start a fresh thread with this provider".
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

interface LockState {
  /** null = unlocked (legacy thread or pre-first-turn). */
  provider: string | null
  model: string | null
}

interface ThreadLockContextValue extends LockState {
  /** Replace the lock state for the active thread (e.g. after thread switch). */
  setLock: (next: LockState) => void
  /** Drop the lock — used when starting a fresh thread. */
  clear: () => void
  /** Imperative read of the current lock (for use inside fetch wrappers
   *  where re-rendering on every change would be wasteful). */
  readLock: () => LockState
}

const ThreadLockContext = createContext<ThreadLockContextValue | null>(null)

export function ThreadLockProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<LockState>({ provider: null, model: null })
  // Mirror in a ref so non-React consumers (the fetch wrapper) can read
  // without subscribing.
  const ref = useRef<LockState>(state)
  ref.current = state

  const setLock = useCallback((next: LockState) => {
    setState((prev) => {
      if (prev.provider === next.provider && prev.model === next.model) return prev
      return next
    })
  }, [])

  const clear = useCallback(() => {
    setState({ provider: null, model: null })
  }, [])

  const readLock = useCallback(() => ref.current, [])

  const value = useMemo<ThreadLockContextValue>(
    () => ({ ...state, setLock, clear, readLock }),
    [state, setLock, clear, readLock],
  )

  return <ThreadLockContext.Provider value={value}>{children}</ThreadLockContext.Provider>
}

export function useThreadLock(): ThreadLockContextValue {
  const ctx = useContext(ThreadLockContext)
  if (!ctx) throw new Error('useThreadLock must be used inside <ThreadLockProvider>')
  return ctx
}
