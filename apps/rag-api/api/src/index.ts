import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { requireTenant } from './middleware/tenant'
import { healthRoutes } from './routes/health'
import { queryRoutes as legacyQueryRoutes } from './routes/query'
import { datasetRoutes as legacyDatasetRoutes } from './routes/datasets'
import { queryRoutes as v1QueryRoutes } from './routes/v1/query'
import { userRoutes as v1UserRoutes } from './routes/v1/users'
import { runMigrations } from './lib/migrate'
import { seedAdminApiKey } from './lib/seed'

const app = new Hono()

app.use('*', logger())

app.route('/', healthRoutes)

const api = new Hono()
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
