import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { runMigrations } from './lib/migrate'
import { corsOptions } from './lib/cors'
import { sessionRoutes } from './routes/session'
import { adminRoutes } from './routes/admin'
import { oauthRoutes } from './routes/oauth'
import { ragRoutes } from './routes/rag'
import { requireSession } from './middleware/session'
import { adminConfigured } from './middleware/admin'

const app = new Hono()

// CORS: env-driven allowlist (see ./lib/cors.ts). Replaces the previous
// reflective `origin: (o) => o, credentials: true` config — that combination
// echoes any caller's Origin and lets cookies through, which is a CSRF
// footgun for a session-cookie-bearing API.
app.use('*', cors(corsOptions()))

app.get('/', (c) =>
  c.json({ name: 'Omega Controller', version: '0.1.0', status: 'running' }),
)
app.get('/healthz', (c) => c.json({ status: 'ok' }))

app.get('/api/me', requireSession, (c) => c.json({ user: c.get('user') }))

app.route('/api/session', sessionRoutes)
app.route('/api/admin', adminRoutes)

// /api/rag/* — browser-facing proxy to rag-api. Routes self-gate on
// session + rag config (503 when RAG is unconfigured). The /enabled
// sub-route is always reachable and reports the feature-flag state to
// the chat UI without round-tripping rag-api.
app.route('/api/rag', ragRoutes)

// Google OAuth is opt-in. Set ENABLE_GOOGLE_OAUTH=true to mount the
// /api/oauth/google/* routes (Drive + per-user token minting). Most
// deploys don't need it on day one.
if ((process.env.ENABLE_GOOGLE_OAUTH ?? 'false').toLowerCase() === 'true') {
  app.route('/api/oauth', oauthRoutes)
} else {
  app.all('/api/oauth/*', (c) =>
    c.json({ error: 'Google OAuth disabled (set ENABLE_GOOGLE_OAUTH=true)' }, 503),
  )
}

const port = Number(process.env.PORT ?? 3000)

if (!process.env.HARNESS_JWT_SECRET) {
  console.warn('[controller] HARNESS_JWT_SECRET not set — /session token minting will fail')
} else if (
  process.env.NODE_ENV === 'production' &&
  process.env.HARNESS_JWT_SECRET.startsWith('dev-only-')
) {
  // The docker-compose default for HARNESS_JWT_SECRET is a literal
  // `dev-only-...` placeholder. Tolerating it in prod would mean every
  // operator who forgot to set the env var ships with an attacker-known
  // signing key. Crash hard so the deploy fails loud.
  throw new Error(
    '[controller] HARNESS_JWT_SECRET is a dev-only placeholder but NODE_ENV=production. ' +
      'Generate a real secret with `openssl rand -hex 32` and set HARNESS_JWT_SECRET.',
  )
}
if (!adminConfigured) {
  console.warn('[controller] ADMIN_BEARER_TOKEN not set — /api/admin/* will return 503')
}

await runMigrations().catch((err) => {
  console.error('[controller] migrations failed', err)
})

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`controller listening on http://localhost:${info.port}`)
})
