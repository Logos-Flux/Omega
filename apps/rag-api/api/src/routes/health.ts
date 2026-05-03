import { Hono } from 'hono'

export const healthRoutes = new Hono()

healthRoutes.get('/healthz', (c) => c.json({ ok: true }))
