import { Hono } from 'hono'

export const queryRoutes = new Hono()

// POST /api/query  — RAG completion. Stub.
queryRoutes.post('/', async (c) => {
  const _tenant = c.get('tenant')
  const body = await c.req.json().catch(() => ({})) as {
    question?: string
    dataset?: string
    top_k?: number
  }
  if (!body.question) return c.json({ error: 'question required' }, 400)
  // TODO: call ragflow.chatCompletion / retrieval scoped to tenant datasets.
  return c.json({ error: 'not implemented' }, 501)
})

// POST /api/retrieve — retrieval only (chunks, no generation). Stub.
queryRoutes.post('/retrieve', async (c) => {
  const _tenant = c.get('tenant')
  return c.json({ error: 'not implemented' }, 501)
})
