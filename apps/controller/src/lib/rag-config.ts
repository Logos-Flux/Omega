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

// Test-only: clear the one-shot warning latch so subsequent tests can
// re-exercise the misconfig path. NOT exported from a barrel; only
// callable from a sibling test file.
export function _resetWarnLatchForTests(): void {
  warned = false
}
