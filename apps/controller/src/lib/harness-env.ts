// OPS-25 — single source of truth for the process.env vars forwarded into
// every pi-harness, shared by BOTH compute backends:
//   - the Sprites bootstrap path  (lib/bootstrap.ts::defaultResolveHarnessEnv)
//   - the Docker provider path     (compute/env.ts::dockerHarnessEnv)
//
// These two builders drifted historically: omitting a var on one backend
// silently disabled a feature there (the RAG_API_URL/RAG_SERVICE_TOKEN
// incident that broke Drive-backed retrieval on Sprites). Deriving both from
// this one list — plus the test asserting they produce identical key sets —
// makes that class of drift impossible.

export const HARNESS_FORWARDED_ENV = [
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'PERPLEXITY_API_KEY',
  'DEEPSEEK_API_KEY',
  // Gates the harness's Ideogram `generate_image` tool (assembler.ts).
  'IDEOGRAM_API_KEY',
  'HARNESS_JWT_SECRET',
  'CONTROLLER_BASE_URL',
  // NB: CONTROLLER_SERVICE_TOKEN is deliberately NOT forwarded — M1 (SEC-01)
  // removed the fleet-shared service token from the Sprite env (it was the
  // cross-user Google-mint vector). The Sprites bootstrap path injects a
  // per-USER CONTROLLER_MINT_TOKEN instead (lib/bootstrap.ts), a computed
  // value rather than a process.env forward, so it isn't in this list.
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'RAG_API_URL',
  'RAG_SERVICE_TOKEN',
  // Gates the harness's Gemini file_search tool (assembler.ts).
  'GEMINI_FILE_SEARCH_STORE',
] as const

/**
 * Build the forwarded subset of `source` (defaults to process.env). Vars that
 * are unset/empty are DROPPED so features that gate on a var stay disabled
 * when it's absent rather than seeing an empty string.
 */
export function forwardedHarnessEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of HARNESS_FORWARDED_ENV) {
    const v = source[k]
    if (typeof v === 'string' && v.length > 0) out[k] = v
  }
  return out
}
