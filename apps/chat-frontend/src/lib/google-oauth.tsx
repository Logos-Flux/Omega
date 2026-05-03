// Phase 0.B.4 — Google OAuth status probe + onboarding gate state.
//
// After the user is CF-Access-authenticated, the SPA calls
// `/api/controller/api/oauth/google/status` (proxied by Caddy) to see
// whether the user has Google OAuth tokens stored on the controller. If
// not, <App> renders the connect-Google gate instead of the chat surface.
//
// Status is held in-memory only (not persisted) — per the roadmap deliverable.
// The "skip for now" escape hatch is recorded in sessionStorage so it
// clears on tab close.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

const API_BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '')
const STATUS_URL = `${API_BASE}/api/controller/api/oauth/google/status`
const SKIP_KEY = '52l.chat.googleConnect.skipped'

export type GoogleStatusState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; connected: boolean }

interface GoogleOAuthValue {
  state: GoogleStatusState
  /** True if the user clicked "Skip for now" this session. */
  skipped: boolean
  refresh: () => Promise<void>
  skipForSession: () => void
}

const GoogleOAuthContext = createContext<GoogleOAuthValue | null>(null)

export function useGoogleOAuth(): GoogleOAuthValue {
  const ctx = useContext(GoogleOAuthContext)
  if (!ctx) throw new Error('useGoogleOAuth must be used inside <GoogleOAuthProvider>')
  return ctx
}

interface GoogleStatusResponse {
  google: {
    connected: boolean
    scopes: string[]
    granted_at: string | null
  }
}

export function GoogleOAuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GoogleStatusState>({ kind: 'loading' })
  const [skipped, setSkipped] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.sessionStorage.getItem(SKIP_KEY) === '1'
    } catch {
      return false
    }
  })

  const refresh = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const res = await fetch(STATUS_URL, { credentials: 'include' })
      if (!res.ok) {
        setState({ kind: 'error', message: `status probe returned ${res.status}` })
        return
      }
      const data = (await res.json()) as GoogleStatusResponse
      const connected = !!data?.google?.connected
      setState({ kind: 'ready', connected })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'network error'
      setState({ kind: 'error', message })
    }
  }, [])

  const skipForSession = useCallback(() => {
    try {
      window.sessionStorage.setItem(SKIP_KEY, '1')
    } catch {
      // sessionStorage may be disabled; we still flip the in-memory flag
      // so the gate clears for this mount.
    }
    setSkipped(true)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const value = useMemo<GoogleOAuthValue>(
    () => ({ state, skipped, refresh, skipForSession }),
    [state, skipped, refresh, skipForSession],
  )

  return <GoogleOAuthContext.Provider value={value}>{children}</GoogleOAuthContext.Provider>
}

/** Build the absolute URL the "Connect Google" button navigates to. */
export function buildOAuthStartUrl(): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const returnTo = `${origin}${API_BASE}/`
  const start = `${API_BASE}/api/controller/api/oauth/google/start`
  return `${start}?return_to=${encodeURIComponent(returnTo)}`
}
