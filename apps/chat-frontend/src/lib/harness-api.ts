// HTTP helpers for harness-side endpoints that aren't part of the chat
// turn (profile, proposals — and later, preferences/persona/audit). The
// settings page reaches the harness directly, the same way the
// HarnessTransport does, but without going through assistant-ui.
//
// Pattern: open a controller session (POST /api/controller/api/session/demo)
// which returns `{sessionId, token, container:{url}}`, then make
// authenticated `fetch(container.url + path)` calls with
// `Authorization: Bearer <token>`. The settings page caches the
// session for the lifetime of the page mount.
//
// Why not reuse `HarnessTransport`? The transport is wired to the
// assistant-ui runtime and only exists inside `<ChatPageInner>`. The
// settings route sits *outside* that tree (the chat surface unmounts
// when the user navigates to /chat/settings) — so we need a
// transport-independent session. The wire shape is the same one
// `harness-transport.ts` uses; if a future commit extracts a shared
// session manager we can reroute both call sites through it.

import type { SessionStartResponse } from './harness-utils'

const API_BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '')

export interface HarnessSessionHandle {
  sessionId: string
  token: string
  container: SessionStartResponse['container']
}

/**
 * The full Profile shape. Mirrors AGENT_ARCHITECTURE.md L451-473 and the
 * harness-side schema. Every field is optional — the harness validates
 * presence on its end. Keep the shape in sync if the schema gains fields.
 */
export interface Profile {
  name?: string
  preferred_name?: string
  timezone?: string
  locale?: string
  communication?: {
    tone_default?: string
    format_preference?: string
    emoji?: string
    length_preference?: string
  }
  work?: {
    company?: string
    role?: string
    domains?: string[]
  }
  personal?: {
    location?: string
    interests?: string[]
  }
}

/**
 * A pending profile update suggested by the agent (via `update_profile`
 * tool). The harness queues these on disk and exposes them through
 * `GET /profile/proposals` for the settings UI to accept or reject.
 *
 * The exact shape is defined harness-side; this is a forgiving client-side
 * type that captures the fields we render. Anything else is preserved
 * but ignored.
 */
export interface ProfileProposal {
  id: string
  /** Dot-path field key, e.g. `personal.location` or `work.role`. */
  field: string
  /** The proposed new value (string, string[], or scalar). */
  value: unknown
  /** ISO 8601 timestamp, when the agent proposed the change. */
  proposed_at?: string
  /** Optional model-supplied rationale. */
  reason?: string
}

/** Open (or fetch) a controller session for the current user. The session
 *  the harness profile endpoints expect is the same one the transport
 *  uses — auth is the harness JWT minted by the controller. */
export async function openSession(): Promise<HarnessSessionHandle> {
  // TODO(phase-1.1): switch to /api/session/start once the user is provisioned.
  const res = await fetch(`${API_BASE}/api/controller/api/session/demo`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`controller /api/session/demo: ${res.status} ${body}`)
  }
  const data = (await res.json()) as SessionStartResponse
  return {
    sessionId: data.sessionId,
    token: data.token,
    container: data.container,
  }
}

/** Authenticated fetch against the harness HTTP. Adds the bearer token
 *  and resolves to the parsed JSON body, throwing on non-2xx. The 4xx
 *  body is preserved on the thrown Error for the UI to surface. */
async function harnessFetch<T>(
  session: HarnessSessionHandle,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `${session.container.url.replace(/\/$/, '')}${path}`
  const headers = new Headers(init?.headers)
  headers.set('authorization', `Bearer ${session.token}`)
  if (init?.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const res = await fetch(url, { ...init, headers })
  if (!res.ok) {
    let detail = ''
    try {
      const j = (await res.clone().json()) as { error?: string }
      detail = j?.error ?? ''
    } catch {
      detail = await res.text().catch(() => '')
    }
    const err = new Error(detail || `${res.status} ${res.statusText}`) as Error & {
      status?: number
      detail?: string
    }
    err.status = res.status
    err.detail = detail
    throw err
  }
  // 204 No Content from accept/reject — return empty object as T.
  if (res.status === 204) return {} as T
  return (await res.json()) as T
}

export async function getProfile(session: HarnessSessionHandle): Promise<Profile> {
  const data = await harnessFetch<{ profile: Profile }>(session, '/profile')
  return data.profile ?? {}
}

export async function putProfile(
  session: HarnessSessionHandle,
  profile: Profile,
): Promise<{ ok: true }> {
  return harnessFetch<{ ok: true }>(session, '/profile', {
    method: 'PUT',
    body: JSON.stringify({ profile }),
  })
}

export async function listProposals(
  session: HarnessSessionHandle,
): Promise<ProfileProposal[]> {
  const data = await harnessFetch<{ proposals: ProfileProposal[] }>(
    session,
    '/profile/proposals',
  )
  return data.proposals ?? []
}

export async function acceptProposal(
  session: HarnessSessionHandle,
  id: string,
): Promise<void> {
  await harnessFetch(session, `/profile/proposals/${encodeURIComponent(id)}/accept`, {
    method: 'POST',
  })
}

export async function rejectProposal(
  session: HarnessSessionHandle,
  id: string,
): Promise<void> {
  await harnessFetch(session, `/profile/proposals/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
  })
}
