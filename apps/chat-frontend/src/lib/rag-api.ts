// Browser client for the controller's /api/rag/* proxy. The chat
// surface never holds the rag-api service bearer — the controller
// injects it on the server side based on the authenticated session
// (see apps/controller/src/routes/rag.ts).
//
// Path convention follows the rest of chat-frontend: prefix every
// fetch with `import.meta.env.BASE_URL` so the SPA works under a
// non-root vite `base` (e.g. `/chat/`). See CLAUDE.md "Path-based
// fetches in SPAs with base: '/chat/'" for the gotcha this avoids.

const API_BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '')

export interface RagStatus {
  /** ISO timestamp of last successful sync, or null if never synced. */
  last_synced_at: string | null
  /** Count of files currently visible to this user via user_file_access. */
  file_count: number
  /** Non-null while a sync job is queued or running. */
  in_flight_job_id: string | null
  /** Last error string from a failed crawl, if any. Cleared on success. */
  last_error: string | null
  /** Whether the user has Drive OAuth tokens stored. */
  drive_oauth_status: 'pending' | 'ok' | 'failed' | string
  /** Whether the user's personal `my-ai/` folder has been resolved. */
  my_ai_folder_status: 'unknown' | 'present' | 'missing'
  // The four fields below are present only when the deploy is in
  // filesystem mode (RAG_SOURCE=filesystem). In drive mode the API
  // omits them entirely so the v0.5.x payload shape is unchanged.
  /** v0.6.x — filesystem subdir readiness. Mirrors the schema column. */
  filesystem_status?: 'unknown' | 'present' | 'missing'
  /** v0.6.x — count of filesystem-source files visible to this user. */
  filesystem_file_count?: number
  /** v0.6.x — most recent finished filesystem-source crawl. */
  filesystem_last_walk_ts?: string | null
}

export interface RagSourceInfo {
  /** Which source the active deploy crawls. */
  mode: 'drive' | 'filesystem'
  /** Capability bundle the chat UI uses to gate sub-features. */
  features: {
    /** True iff this controller has Drive OAuth mounted AND mode='drive'. */
    oauth: boolean
    /** Whether a user can hit "Sync now" (audit-logged on the backend). */
    manual_ingest: boolean
    /** Whether the deploy has a shared content surface (KB folder /
     *  flat filesystem dir). */
    shared_folder: boolean
  }
}

export interface SyncResponse {
  job_id: string
  status: 'queued' | 'running' | 'completed' | string
}

export interface ForgetResponse {
  ok: true
  removed_files: number
}

class RagApiError extends Error {
  constructor(public status: number, public detail: string) {
    super(`rag-api ${status}: ${detail.slice(0, 200)}`)
  }
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/controller${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new RagApiError(res.status, detail)
  }
  return (await res.json()) as T
}

/** GET /api/rag/enabled — feature flag. Reachable without a session;
 *  returns `{enabled: false}` rather than throwing when RAG is
 *  unconfigured, so the UI can gate cleanly. */
export async function getRagEnabled(): Promise<boolean> {
  try {
    const data = await jsonFetch<{ enabled: boolean }>('/api/rag/enabled')
    return Boolean(data.enabled)
  } catch {
    // Network failures or controller-down are treated as "not
    // available" rather than surfacing as a user-facing error — the
    // UX is the same (hide the card).
    return false
  }
}

/** GET /api/rag/source — feature-flag-style probe. Reachable without a
 *  session, like /enabled. Tells the chat-frontend which Connectors
 *  pane to render and which sub-features (oauth / shared folder) the
 *  deploy has wired up. */
export async function getRagSource(): Promise<RagSourceInfo> {
  return jsonFetch<RagSourceInfo>('/api/rag/source')
}

/** GET /api/rag/status — fetches the current sync state for the
 *  authenticated user. Throws on 4xx/5xx. */
export async function getRagStatus(): Promise<RagStatus> {
  return jsonFetch<RagStatus>('/api/rag/status')
}

/** POST /api/rag/sync — kick off (or join) a Drive crawl. Pass
 *  force=true to bypass the in-flight-job idempotency check. */
export async function triggerRagSync(force = false): Promise<SyncResponse> {
  return jsonFetch<SyncResponse>('/api/rag/sync', {
    method: 'POST',
    body: JSON.stringify({ force }),
  })
}

/** POST /api/rag/forget — drop user_file_access rows + GC orphan
 *  files. Idempotent; returns `removed_files: 0` when nothing is
 *  cataloged for the user. */
export async function forgetRag(): Promise<ForgetResponse> {
  return jsonFetch<ForgetResponse>('/api/rag/forget', { method: 'POST' })
}
