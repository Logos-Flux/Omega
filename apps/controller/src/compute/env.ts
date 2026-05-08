/**
 * Env block injected into every per-user pi-harness container spawned by
 * DockerProvider. Lazy reads of `process.env` so tests / per-process
 * overrides take effect.
 *
 * If a value is unset on the controller, `undefined` flows through and
 * the harness sees the var unset — features that gate on it (notably
 * `rag_search`, which requires both `RAG_API_URL` and `RAG_SERVICE_TOKEN`)
 * silently disable themselves rather than half-register.
 *
 * Lives in its own module (rather than co-located with the factory in
 * `./index`) so tests can import it directly and bypass the
 * `mock.module('../compute', …)` stub that the session route tests
 * install for the singleton factory.
 */
export function dockerHarnessEnv(): Record<string, string | undefined> {
  return {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
    HARNESS_JWT_SECRET: process.env.HARNESS_JWT_SECRET,
    WORKSPACE_ROOT: '/workspace',
    PORT: '8080',
    RAG_API_URL: process.env.RAG_API_URL,
    RAG_SERVICE_TOKEN: process.env.RAG_SERVICE_TOKEN,
  }
}
