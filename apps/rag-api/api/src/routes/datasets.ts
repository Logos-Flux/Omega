import { Hono } from 'hono'

export const datasetRoutes = new Hono()

// GET /api/datasets — list this tenant's datasets. Stub.
datasetRoutes.get('/', async (c) => {
  const _tenant = c.get('tenant')
  return c.json({ datasets: [] })
})

// POST /api/datasets — create a new dataset for this tenant. Stub.
datasetRoutes.post('/', async (c) => {
  const _tenant = c.get('tenant')
  return c.json({ error: 'not implemented' }, 501)
})
