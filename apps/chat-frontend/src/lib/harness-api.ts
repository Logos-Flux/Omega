// HTTP helpers for harness-side endpoints that aren't part of the chat
// turn (profile, proposals — and later, preferences/persona/audit). The
// settings page reaches the harness directly, the same way the
// HarnessTransport does, but without going through assistant-ui.
//
// Pattern: open a controller session (POST /api/controller/api/session/start)
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
 *  uses — auth is the harness JWT minted by the controller.
 *
 *  Retries on 409 (concurrent provisioning) with the same backoff the
 *  chat-surface transport uses: a second `/start` racing the first
 *  surfaces 409 until the other call commits the row; on retry we hit
 *  the existing-row fast path. Mirrors `harness-transport.ts`. */
export async function openSession(): Promise<HarnessSessionHandle> {
  const url = `${API_BASE}/api/controller/api/session/start`
  const delays = [1500, 4000]
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: 'POST', credentials: 'include' })
    if (res.ok) {
      const data = (await res.json()) as SessionStartResponse
      return {
        sessionId: data.sessionId,
        token: data.token,
        container: data.container,
      }
    }
    const body = await res.text().catch(() => '')
    if (res.status === 409 && attempt < delays.length) {
      await new Promise((r) => setTimeout(r, delays[attempt]))
      continue
    }
    throw new Error(`controller /api/session/start: ${res.status} ${body}`)
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

// ---------- Agent-mode conversation history (thread switcher) ----------

export interface ConversationMeta {
  id: string
  title: string | null
  updatedAt: string
  messageCount: number
}

export interface ConversationLine {
  ts: string
  role: 'user' | 'assistant'
  text: string
  provider?: string
  model?: string
  id?: string
  partial?: boolean
}

// One cached session for the switcher's read-only history calls (list + load),
// so polling the thread list doesn't mint a new controller session per call.
// The chat surface keeps its own active session via the transport; this is
// only for metadata reads outside that tree (mirrors the settings page's
// session caching). The conversations the user actually sees in the list are
// filtered to non-empty ones, so this session's own (empty) shell never shows.
let metaSession: Promise<HarnessSessionHandle> | null = null
function getMetaSession(): Promise<HarnessSessionHandle> {
  if (!metaSession) {
    metaSession = openSession().catch((e) => {
      metaSession = null
      throw e
    })
  }
  return metaSession
}

// Run a harness call against the cached meta-session; if the token has expired
// (401), drop the cache and retry once with a fresh session.
async function withMetaSession<T>(fn: (s: HarnessSessionHandle) => Promise<T>): Promise<T> {
  try {
    return await fn(await getMetaSession())
  } catch (e) {
    if ((e as { status?: number }).status === 401) {
      metaSession = null
      return fn(await getMetaSession())
    }
    throw e
  }
}

export async function listAgentSessions(): Promise<ConversationMeta[]> {
  return withMetaSession(async (session) => {
    const data = await harnessFetch<{ sessions: ConversationMeta[] }>(session, '/conversations')
    return data.sessions ?? []
  })
}

export async function loadAgentSession(id: string): Promise<ConversationLine[]> {
  return withMetaSession(async (session) => {
    const data = await harnessFetch<{ id: string; lines: ConversationLine[] }>(
      session,
      `/conversations/${encodeURIComponent(id)}`,
    )
    return data.lines ?? []
  })
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

// ---------- Skills (#3 toggle + #4 generated-skill management) ------------

export interface SkillInfo {
  name: string
  description: string
  /** Flat per-user toggle — false means hidden from the agent. */
  enabled: boolean
  /** 'user' skills (agent-created) are deletable; 'baked' golden skills aren't. */
  source: 'user' | 'baked'
}

export async function getSkills(session: HarnessSessionHandle): Promise<SkillInfo[]> {
  const data = await harnessFetch<{ skills: SkillInfo[] }>(session, '/skills')
  return data.skills ?? []
}

export async function setSkillEnabled(
  session: HarnessSessionHandle,
  name: string,
  enabled: boolean,
): Promise<void> {
  await harnessFetch(session, `/skills/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}

export async function deleteSkill(session: HarnessSessionHandle, name: string): Promise<void> {
  await harnessFetch(session, `/skills/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

// ---------- Memory (#5) ----------------------------------------------------

export async function getMemory(session: HarnessSessionHandle): Promise<string> {
  const data = await harnessFetch<{ memory: string }>(session, '/memory')
  return data.memory ?? ''
}

export async function putMemory(session: HarnessSessionHandle, memory: string): Promise<void> {
  await harnessFetch(session, '/memory', { method: 'PUT', body: JSON.stringify({ memory }) })
}

export async function clearMemory(session: HarnessSessionHandle): Promise<void> {
  await harnessFetch(session, '/memory', { method: 'DELETE' })
}

// ---------- Personas (#6) --------------------------------------------------

export interface PersonaInfo {
  name: string
  label: string
}

export async function listPersonas(
  session: HarnessSessionHandle,
): Promise<{ personas: PersonaInfo[]; active: string }> {
  const data = await harnessFetch<{ personas: PersonaInfo[]; active: string }>(session, '/personas')
  return { personas: data.personas ?? [], active: data.active ?? 'default' }
}

export async function setPersona(session: HarnessSessionHandle, name: string): Promise<void> {
  await harnessFetch(session, '/persona', { method: 'PUT', body: JSON.stringify({ name }) })
}
