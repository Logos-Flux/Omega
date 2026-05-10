// RAG service config. Plumbing only — read by the (future) /api/rag
// proxy routes and the pi-harness rag.search skill via the controller.
// Lazy env reads so tests and per-process overrides take effect.
//
// Wiring contract:
//   - Both vars set    → RAG is enabled; the proxy + skill register.
//   - Both vars unset  → RAG is disabled; UI hides the Connect-Drive
//                        card and no RAG calls are issued.
//   - One set, one not → almost certainly a misconfig; treat as
//                        disabled and log a one-shot warning so the
//                        operator can see it in `flyctl logs` etc.

export interface RagConfig {
  apiUrl: string
  serviceToken: string
}

let warned = false

export function getRagConfig(): RagConfig | null {
  const apiUrl = process.env.RAG_API_URL?.trim()
  const serviceToken = process.env.RAG_SERVICE_TOKEN?.trim()
  if (!apiUrl && !serviceToken) return null
  if (!apiUrl || !serviceToken) {
    if (!warned) {
      console.warn(
        '[rag-config] one of RAG_API_URL / RAG_SERVICE_TOKEN is set without the other — RAG features disabled',
      )
      warned = true
    }
    return null
  }
  return { apiUrl: apiUrl.replace(/\/$/, ''), serviceToken }
}

export function isRagEnabled(): boolean {
  return getRagConfig() !== null
}

// ---------------------------------------------------------------------
// Source-mode helpers — back the GET /api/rag/source route. The chat
// frontend reads /api/rag/source on first render to pick a state machine
// (DriveConnectPane vs FilesystemPane). The controller and the
// rag-ingest worker must agree on RAG_SOURCE; the deploy is responsible
// for setting it identically in both containers.
// ---------------------------------------------------------------------

export type RagSourceMode = 'drive' | 'filesystem'

/**
 * Pick the source mode from RAG_SOURCE. Defaults to 'drive' so existing
 * 52L/Helsinki deploys keep working without a config change. Unknown
 * values fall back to 'drive' with a one-shot warning rather than
 * crashing — a typo here shouldn't take down the controller.
 *
 * 'both' isn't supported in v0.6.0 (the rag-ingest crawler explicitly
 * rejects it); treat it as drive on the controller for symmetry.
 */
let unknownSourceWarned = false
export function getRagSourceMode(): RagSourceMode {
  const raw = (process.env.RAG_SOURCE ?? 'drive').trim().toLowerCase()
  if (raw === 'drive' || raw === '') return 'drive'
  if (raw === 'filesystem') return 'filesystem'
  if (!unknownSourceWarned) {
    console.warn(
      `[rag-config] RAG_SOURCE=${raw} not recognised; treating as 'drive' ` +
        `(valid values: 'drive', 'filesystem')`,
    )
    unknownSourceWarned = true
  }
  return 'drive'
}

/**
 * Whether Drive OAuth is wired up on this controller. The mount of
 * /api/oauth/google/* is gated on ENABLE_GOOGLE_OAUTH (see index.ts).
 * In filesystem mode, OAuth is irrelevant regardless of the env value.
 */
export function isOAuthEnabled(): boolean {
  if (getRagSourceMode() === 'filesystem') return false
  return (process.env.ENABLE_GOOGLE_OAUTH ?? 'false').toLowerCase() === 'true'
}

/**
 * Whether the deploy has a "shared content" surface configured.
 *   drive mode      — RAG_KNOWLEDGE_BASE_FOLDER_ID points at a folder
 *                     every user crawls.
 *   filesystem mode — v0.6.0 ships flat layout, so every file in
 *                     RAG_FILES_DIR is shared with every tenant user
 *                     by definition. We don't probe the filesystem
 *                     here — the controller often runs in a different
 *                     container than the worker, so the directory
 *                     check would be misleading.
 */
export function hasSharedFolder(): boolean {
  if (getRagSourceMode() === 'filesystem') return true
  return (process.env.RAG_KNOWLEDGE_BASE_FOLDER_ID ?? '').trim().length > 0
}

// Test-only: clear the one-shot warning latches so subsequent tests can
// re-exercise the misconfig paths. NOT exported from a barrel; only
// callable from a sibling test file.
export function _resetWarnLatchForTests(): void {
  warned = false
  unknownSourceWarned = false
}
