import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/**
 * Auth provider for Omega frontends.
 *
 * Two operating modes:
 *
 * 1. **API-backed** (default) — fetches `${apiBase}/api/me` on mount and
 *    surfaces the returned user. The chat-api / controller stubs return
 *    a single-user identity by default (`DEFAULT_USER_EMAIL`); operators
 *    swap that for a real auth verifier (CF Access JWKS, OIDC, etc.) at
 *    the API layer without touching the SPA.
 *
 * 2. **Fake** — pass `fakeUser` to skip the network and authenticate as
 *    that user immediately. Useful for previewing the shell without the
 *    API layer running. Production builds should never set this.
 *
 * `signOut()` clears the Cloudflare Access session if `cfAccessTeamDomain`
 * is set; otherwise it just reloads the page (which causes the next
 * `/api/me` to redirect-or-anonymous, depending on operator setup).
 */

export interface SessionUser {
  id: string
  email: string
  name: string | null
  picture: string | null
  sub: string
}

/** Older alias kept for callers that imported `AuthUser` pre-port. */
export type AuthUser = SessionUser

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous'

export interface AuthState {
  user: SessionUser | null
  status: AuthStatus
  signOut: () => void
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export interface AuthProviderProps {
  children: ReactNode
  /**
   * Same-origin URL prefix for the app's API. Defaults to the current
   * origin with no prefix. Pass `import.meta.env.BASE_URL` (or a constant
   * derived from it) when the SPA is served under a sub-path like
   * `/chat/`. The provider hits `${apiBase}/api/me` to load the session.
   */
  apiBase?: string
  /**
   * Cloudflare Access team domain (e.g. `https://omega.cloudflareaccess.com`).
   * Used by `signOut()` to clear the CF_Authorization cookie. If omitted,
   * `signOut()` just reloads the page.
   */
  cfAccessTeamDomain?: string
  /**
   * Dev-only override. When provided, skips the `/api/me` probe and
   * authenticates as this user.
   */
  fakeUser?: SessionUser
}

export function AuthProvider({
  children,
  apiBase = '',
  cfAccessTeamDomain,
  fakeUser,
}: AuthProviderProps) {
  const [user, setUser] = useState<SessionUser | null>(fakeUser ?? null)
  const [status, setStatus] = useState<AuthStatus>(fakeUser ? 'authenticated' : 'loading')

  const base = useMemo(() => apiBase.replace(/\/$/, ''), [apiBase])

  const refresh = useCallback(async () => {
    if (fakeUser) {
      setUser(fakeUser)
      setStatus('authenticated')
      return
    }
    try {
      const res = await fetch(`${base}/api/me`, { credentials: 'include' })
      if (res.ok) {
        const data = (await res.json()) as { user: SessionUser }
        setUser(data.user)
        setStatus('authenticated')
      } else {
        setUser(null)
        setStatus('anonymous')
      }
    } catch (err) {
      console.error('[app-shell/auth] /api/me failed', err)
      setUser(null)
      setStatus('anonymous')
    }
  }, [base, fakeUser])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const signOut = useCallback(() => {
    if (cfAccessTeamDomain) {
      window.location.href = `${cfAccessTeamDomain.replace(/\/$/, '')}/cdn-cgi/access/logout`
    } else {
      window.location.reload()
    }
  }, [cfAccessTeamDomain])

  const value = useMemo<AuthState>(
    () => ({ user, status, signOut, refresh }),
    [user, status, signOut, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}
