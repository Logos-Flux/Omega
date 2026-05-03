import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { runMigrations } from './lib/migrate'
import { corsOptions } from './lib/cors'
import { chatRoutes } from './routes/chat'
import { threadRoutes } from './routes/threads'
import { requireSession } from './middleware/session'

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

// /api/me — session probe for the frontend, served on the same /api origin so
// the cookie is sent naturally through Vite's dev proxy.
app.get('/api/me', requireSession, (c) => c.json({ user: c.get('user') }))

app.route('/api/chat', chatRoutes)
app.route('/api/threads', threadRoutes)

const port = Number(process.env.PORT ?? 3000)

await runMigrations().catch((err) => {
  console.error('[chat-api] migrations failed', err)
})

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`chat-api listening on http://localhost:${info.port}`)
})
