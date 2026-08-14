// Liveness probe for a per-user Sprite's pi-harness.
//
// Why this exists: a Sprite auto-checkpoints to `cold` when idle, which
// kills the foreground harness process started during bootstrap. Nothing
// inside the Sprite restarts it on warm-up (no systemd, no boot hook). So a
// returning user's Sprite exists but its harness is dead — the browser's WS
// upgrade hangs forever. `/api/session/start` uses this probe on the
// existing-row path: if the harness isn't answering, it re-runs the
// idempotent bootstrap to restart it before handing back the URL.
//
// `/healthz` is the harness's only unauthenticated endpoint (no JWT needed),
// so a bare GET is sufficient. A cold Sprite's URL proxy may stall while it
// warms with nothing listening behind it, so the probe is bounded by a short
// timeout — a slow/no response is treated as unhealthy, which is the correct
// trigger for a re-bootstrap (bootstrap warms + (re)starts the harness).
//
// `redirect: 'manual'` is load-bearing: a Sprite whose URL auth is still
// `sprite` (e.g. a half-provisioned sprite whose bootstrap died before the
// flip-to-public step) answers /healthz with a 302 to the Sprites login page.
// Following that redirect lands on a 200 login page and would make the probe
// report "healthy" — masking a sprite with no running harness and skipping the
// re-bootstrap that would fix it. With manual redirect the 302 surfaces as
// `res.ok === false`, i.e. correctly "down".

export type HealthzFetcher = (url: string, signal: AbortSignal) => Promise<Response>

const defaultFetch: HealthzFetcher = (url, signal) =>
  fetch(url, { signal, redirect: 'manual' })

/**
 * Returns true iff the harness at `baseUrl` answers `GET /healthz` with a 2xx
 * within `timeoutMs`. Never throws — any network error, non-2xx, or timeout
 * resolves to `false`.
 */
export async function harnessHealthy(
  baseUrl: string,
  opts: { timeoutMs?: number; fetchImpl?: HealthzFetcher } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 6_000
  const fetchImpl = opts.fetchImpl ?? defaultFetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${baseUrl}/healthz`, controller.signal)
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
