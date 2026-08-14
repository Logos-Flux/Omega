import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { requireTenant } from './middleware/tenant'
import { requireOriginSecret } from './middleware/origin-secret'
import { healthRoutes } from './routes/health'
import { queryRoutes as legacyQueryRoutes } from './routes/query'
import { datasetRoutes as legacyDatasetRoutes } from './routes/datasets'
import { queryRoutes as v1QueryRoutes } from './routes/v1/query'
import { userRoutes as v1UserRoutes } from './routes/v1/users'
import { runMigrations } from './lib/migrate'
import { seedAdminApiKey } from './lib/seed'
import { getPool } from './lib/db'

// QUAL-12 — process-level crash backstops.
process.on('unhandledRejection', (reason) => {
  console.error('[rag-api] unhandledRejection — exiting', reason)
  process.exit(1)
})
process.on('uncaughtException', (err) => {
  console.error('[rag-api] uncaughtException — exiting', err)
  process.exit(1)
})

const app = new Hono()

app.use('*', logger())

// OPS-11 — readiness probe (DB dependency) ahead of the tenant gate.
app.get('/readyz', async (c) => {
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
    // credentials). Log the real reason, return a fixed token.
    console.error('[readyz] db probe failed:', (e as Error).message)
    return c.json({ status: 'not_ready', error: 'db_unreachable' }, 503)
  } finally {
    // SELECT 1 winning the race leaves the 2s timer pending — clear it.
    clearTimeout(probeTimer)
  }
})

app.route('/', healthRoutes)

const api = new Hono()
// SEC-03 — origin-secret gate (no-op until ORIGIN_SHARED_SECRET is set, and
// deferred for Authorization-bearing s2s callers, which is all of rag-api's
// current traffic). Health/info routes live under '/' and stay exempt.
api.use('*', requireOriginSecret)
api.use('*', requireTenant)

// v1 — the contract chat consumes (RAG-HANDOFF.md).
const v1 = new Hono()
v1.route('/query', v1QueryRoutes)
v1.route('/users', v1UserRoutes)
api.route('/v1', v1)

// Legacy 501 stubs from the original scaffold. Kept for one release so
// callers see a soft signal before the path disappears.
api.use('/query', async (c, next) => {
  c.header('Deprecation', 'true')
  c.header('Link', '</api/v1/query>; rel="successor-version"')
  await next()
})
api.use('/datasets', async (c, next) => {
  c.header('Deprecation', 'true')
  await next()
})
api.route('/query', legacyQueryRoutes)
api.route('/datasets', legacyDatasetRoutes)

app.route('/api', api)

const port = Number(process.env.PORT ?? 3100)

await runMigrations()
await seedAdminApiKey()

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`rag-api listening on :${info.port}`)
})
