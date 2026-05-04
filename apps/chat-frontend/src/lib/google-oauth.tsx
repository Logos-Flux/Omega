// Phase 0.B.4 — Google OAuth status probe + onboarding gate state.
//
// After the user is CF-Access-authenticated, the SPA calls
// `/api/controller/api/oauth/google/health` (proxied by Caddy) which does
// a real refresh-token exchange against Google. The earlier /status route
// only checked row existence and produced a permanent dead-end whenever a
// stored grant rotted (revoked, decrypt failure, scope drift): the gate
// passed but the harness silently couldn't mint. /health distinguishes
// "really connected" from "row exists but mint fails" so the SPA can
// re-prompt for consent or surface a transient-error retry.
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
const HEALTH_URL = `${API_BASE}/api/controller/api/oauth/google/health`
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

type GoogleHealthResponse =
  | { ok: true; scopes: string[]; granted_at: string | null }
  | {
      ok: false
      reason: 'no_grant' | 'revoked' | 'decrypt_failed' | 'transient' | 'misconfigured'
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
      const res = await fetch(HEALTH_URL, { credentials: 'include' })
      if (!res.ok && res.status !== 503) {
        // 503 carries a structured `misconfigured` body — let the JSON parse
        // run. Anything else (404 from a stale Caddy, 500 unexpected) → error.
        setState({ kind: 'error', message: `health probe returned ${res.status}` })
        return
      }
      const data = (await res.json()) as GoogleHealthResponse
      if (data.ok) {
        setState({ kind: 'ready', connected: true })
        return
      }
      // Transient + misconfigured are server-side problems we don't want to
      // resolve by forcing a re-consent loop — show the retry screen instead.
      if (data.reason === 'transient' || data.reason === 'misconfigured') {
        setState({
          kind: 'error',
          message:
            data.reason === 'transient'
              ? 'Google check temporarily unavailable'
              : 'Google OAuth not configured on the server',
        })
        return
      }
      // no_grant | revoked | decrypt_failed → user needs to (re)consent.
      setState({ kind: 'ready', connected: false })
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
