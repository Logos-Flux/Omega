import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { runMigrations } from './lib/migrate'
import { corsOptions } from './lib/cors'
import { chatRoutes } from './routes/chat'
import { threadRoutes } from './routes/threads'
import { requireSession } from './middleware/session'
import { requireOriginSecret } from './middleware/origin-secret'
import { getPool, hasDatabase } from './lib/db'

// QUAL-12 — process-level backstops. Without these a stray unhandled rejection
// or uncaught exception leaves the process in an undefined state with no
// signal; crash loudly so Fly restarts a clean machine and the failure is
// visible in logs (and, once wired, the error tracker).
process.on('unhandledRejection', (reason) => {
  console.error('[chat-api] unhandledRejection — exiting', reason)
  process.exit(1)
})
process.on('uncaughtException', (err) => {
  console.error('[chat-api] uncaughtException — exiting', err)
  process.exit(1)
})

const app = new Hono()

app.use(
  '*',
  // CORS: env-driven allowlist. See ./lib/cors.ts. exposeHeaders are the
  // custom response headers the SPA reads off /api/chat — the browser only
  // exposes non-CORS-safelisted headers when the server explicitly opts
  // them in. Same-origin (Caddy proxy in prod) doesn't need this, but the
  // Vite dev proxy hits a cross-origin shape.
  cors(
    corsOptions({
      exposeHeaders: ['X-Locked-Provider', 'X-Locked-Model', 'X-Lock-Mismatched'],
    }),
  ),
)

app.get('/', (c) =>
  c.json({ name: 'Omega Chat API', version: '0.1.0', status: 'running' }),
)
app.get('/healthz', (c) => c.json({ status: 'ok' }))

// OPS-11 — readiness probe with a dependency check (vs /healthz liveness).
// The external uptime monitor + Fly can target this to catch "process up but
// DB unreachable". Bounded so a wedged DB returns 503 fast, not a hang.
app.get('/readyz', async (c) => {
  if (!hasDatabase) return c.json({ status: 'ready', db: 'disabled' })
  let probeTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      getPool().query('SELECT 1'),
      new Promise((_, rej) => {
        probeTimer = setTimeout(() => rej(new Error('db probe timeout')), 2000)
      }),
    ])
    return c.json({ status: 'ready' })
  } catch (e) {
    // Unauthenticated probe — don't echo the raw pg error (can leak host /
    // credentials, e.g. "password authentication failed for user ..."). Log
    // the real reason, return a fixed token.
    console.error('[readyz] db probe failed:', (e as Error).message)
    return c.json({ status: 'not_ready', error: 'db_unreachable' }, 503)
  } finally {
    // SELECT 1 winning the race leaves the 2s timer pending — clear it so a
    // frequently-polled /readyz doesn't leak a timer per request.
    clearTimeout(probeTimer)
  }
})

// SEC-03 — origin-secret gate on all /api/* (no-op until ORIGIN_SHARED_SECRET
// is set). Mounted after CORS (so preflight is answered) and before the routes.
app.use('/api/*', requireOriginSecret)

// /api/me — session probe for the frontend, served on the same /api origin so
// the cookie is sent naturally through Vite's dev proxy.
app.get('/api/me', requireSession, (c) => c.json({ user: c.get('user') }))

app.route('/api/chat', chatRoutes)
app.route('/api/threads', threadRoutes)

const port = Number(process.env.PORT ?? 3000)

// DB-08 — fail the boot if migrations fail. Serving traffic after a failed
// migration means /healthz stays green while routes 500 far from the cause;
// a hard exit makes the deploy abort with the old machine still serving.
await runMigrations().catch((err) => {
  console.error('[chat-api] migrations failed — exiting', err)
  process.exit(1)
})

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`chat-api listening on http://localhost:${info.port}`)
})
