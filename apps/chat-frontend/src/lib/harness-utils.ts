// Helpers shared by the HarnessTransport and Agent-Mode UI bits (uploads
// accordion, banner, etc.). Originally lived inside the now-deleted
// `AgentChat.tsx`. Pulled out so a single utilities module can serve both
// the transport (lib) and the UI (components).

// Build-time override (Vite inlines `import.meta.env.VITE_*` at build).
// Default raised from 1 MB → 100 MB on 2026-05-14 — 1 MB blocked any
// real PDF or presentation. Server-side limit lives in
// `apps/pi-harness/src/uploads.ts:MAX_BYTES` and must be at least as
// permissive as this client cap, or the harness 413's.
export const MAX_UPLOAD_BYTES = Number(import.meta.env.VITE_MAX_UPLOAD_BYTES) || 100_000_000

// First-ever provision (apt install of poppler/pandoc/weasyprint + npm
// globals + harness boot + healthz) takes ~3–5 minutes on a brand-new
// sprite. Subsequent unfreezes from checkpoint are seconds. Harness
// restarts during an update-orchestrator run also briefly drop WS
// connections. Sum of these delays must comfortably exceed the cold-
// provision budget so a user toggling Agent Mode mid-warmup doesn't
// see a red error before bootstrap finishes; total budget here ≈ 6m.
export const WS_RETRY_DELAYS_MS = [3000, 5000, 10000, 30000, 45000, 60000, 60000, 60000, 60000]

// WP-894 — application-level WebSocket keepalive. Browsers cannot emit WS
// protocol-level ping frames from JS, so without an app-level ping the client
// has no way to tell a *half-dead* socket (laptop sleep, Wi-Fi handoff,
// backgrounded tab where the OS suspended the radio) from a live-but-thinking
// one. The transport sends `{type:'ping'}` when the connection has been idle
// longer than the interval; the harness replies `{type:'pong'}` (see
// apps/pi-harness/src/index.ts). If a ping goes unanswered past the timeout,
// the watchdog force-closes the socket so the existing onWsClose → reconnect
// → resume path fires — instead of the user's next message stalling on
// "Thinking…" against a socket the browser still reports as OPEN.
//
// Interval is deliberately long: during active streaming/tool use, inbound
// frames reset the idle timer, so pings only go out during genuine quiet
// (long model thinks, idle between turns). Timeout is generous because a live
// sprite answers a WS frame in milliseconds — anything past this is dead.
export const WS_KEEPALIVE_INTERVAL_MS = 25_000
export const WS_KEEPALIVE_TIMEOUT_MS = 15_000

export interface SessionStartResponse {
  sessionId: string
  token: string
  container: { name: string; url: string; provider: string }
}

export interface UploadInfo {
  filename: string
  size: number
  contentType?: string
}

export interface SkillSummary {
  name: string
  description: string
}

export interface SourceRef {
  uri: string
  title?: string
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// Best-effort short hint summarising a tool's input. Kept here (instead
// of inside the transport) so the agent-mode UI accordions can reuse it
// for the same look-and-feel as the inline tool chips.
export function summarizeToolInput(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const obj = input as Record<string, unknown>
  switch (name) {
    case 'read_skill':
      return typeof obj.name === 'string' ? obj.name : undefined
    case 'exec': {
      const cmd = typeof obj.command === 'string' ? obj.command : undefined
      const args = Array.isArray(obj.args) ? (obj.args as unknown[]) : []
      if (!cmd) return undefined
      if (['gccli', 'gdcli', 'gmcli'].includes(cmd) && args.length >= 2) {
        return `${cmd} ${args[1]}`
      }
      return cmd
    }
    case 'web_search':
    case 'google_search':
      return typeof obj.query === 'string'
        ? obj.query.length > 30
          ? obj.query.slice(0, 30) + '…'
          : obj.query
        : undefined
    case 'read_upload':
    case 'write_file':
      return typeof obj.filename === 'string' ? obj.filename : undefined
    case 'write_memory':
      return typeof obj.mode === 'string' ? obj.mode : 'append'
    case 'list_uploads':
      return undefined
    default:
      return undefined
  }
}

export function uploadDownloadUrl(
  baseUrl: string,
  sessionId: string,
  filename: string,
  token: string,
): string {
  return `${baseUrl}/files/${encodeURIComponent(sessionId)}/${encodeURIComponent(filename)}?token=${encodeURIComponent(token)}`
}

export function fileTypeMeta(ext: string): { label: string; bg: string; fg: string } {
  switch (ext) {
    case 'pdf':
      return { label: 'PDF', bg: 'bg-red-100', fg: 'text-red-600' }
    case 'docx':
    case 'doc':
      return { label: 'Word', bg: 'bg-blue-100', fg: 'text-blue-600' }
    case 'xlsx':
    case 'xls':
    case 'csv':
      return { label: ext === 'csv' ? 'CSV' : 'Excel', bg: 'bg-emerald-100', fg: 'text-emerald-600' }
    case 'pptx':
    case 'ppt':
      return { label: 'PowerPoint', bg: 'bg-orange-100', fg: 'text-orange-600' }
    case 'md':
      return { label: 'Markdown', bg: 'bg-t-accent/10', fg: 'text-t-accent' }
    case 'json':
      return { label: 'JSON', bg: 'bg-amber-100', fg: 'text-amber-600' }
    case 'txt':
      return { label: 'Text', bg: 'bg-t-hover', fg: 'text-t-muted' }
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
      return { label: ext.toUpperCase(), bg: 'bg-violet-100', fg: 'text-violet-600' }
    default:
      return { label: ext ? ext.toUpperCase() : 'File', bg: 'bg-t-hover', fg: 'text-t-muted' }
  }
}
