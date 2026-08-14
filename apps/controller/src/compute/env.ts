import { forwardedHarnessEnv } from '../lib/harness-env'

/**
 * Env block injected into every per-user pi-harness container spawned by
 * DockerProvider. Lazy reads of `process.env` so tests / per-process
 * overrides take effect.
 *
 * OPS-25 — the forwarded var set is shared with the Sprites bootstrap path
 * (lib/bootstrap.ts::defaultResolveHarnessEnv) via lib/harness-env.ts, with a
 * test asserting both builders produce identical keys. Unset vars are dropped
 * so a feature that gates on a var (e.g. `rag_search` needs RAG_API_URL +
 * RAG_SERVICE_TOKEN) self-disables rather than half-registering.
 *
 * Lives in its own module (rather than co-located with the factory in
 * `./index`) so tests can import it directly and bypass the
 * `mock.module('../compute', …)` stub that the session route tests
 * install for the singleton factory.
 */
export function dockerHarnessEnv(): Record<string, string> {
  return {
    WORKSPACE_ROOT: '/workspace',
    PORT: '8080',
    ...forwardedHarnessEnv(),
  }
}
