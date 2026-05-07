import { createContext, useContext, type ReactNode } from 'react'

/**
 * Auth stub for the OSS build.
 *
 * Operators add their own auth at the reverse-proxy layer (oauth2-proxy,
 * Caddy basic auth, Tailscale serve, etc.) — the SPA doesn't enforce auth
 * itself. The original closed-source deployment used this provider to verify a
 * Cloudflare Access JWT and gate the chat surface; the OSS replacement
 * always returns `status: 'authenticated'` so the gate is open.
 *
 * Drop-in replacement for multi-user deployments: replace this file with
 * a real auth verifier (e.g. CF Access JWKS check, OIDC + iframe poll,
 * etc.) and surface the user via `useAuth()`.
 */

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous'

export interface AuthUser {
  id: string
  email: string
  name: string | null
  picture: string | null
  sub: string
}

interface AuthContextValue {
  status: AuthStatus
  user: AuthUser | null
}

const DEFAULT_USER: AuthUser = {
  id: 'local-user',
  email: 'local@localhost',
  name: 'Local User',
  picture: null,
  sub: 'local:local-user',
}

const AuthContext = createContext<AuthContextValue>({
  status: 'authenticated',
  user: DEFAULT_USER,
})

export interface AuthProviderProps {
  children: ReactNode
  /** Reserved — kept for API parity with hosted shells. */
  apiBase?: string
  /** Reserved — kept for API parity with hosted shells. */
  cfAccessTeamDomain?: string
  /** Reserved — kept for API parity with hosted shells. */
  fakeUser?: AuthUser
}

export function AuthProvider({ children, fakeUser }: AuthProviderProps) {
  const value: AuthContextValue = {
    status: 'authenticated',
    user: fakeUser ?? DEFAULT_USER,
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}
