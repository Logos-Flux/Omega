import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { requireOriginSecret } from './origin-secret'

// SEC-03 — origin-secret middleware. Armed only when ORIGIN_SHARED_SECRET is
// set; browser traffic must carry the CF-injected X-Origin-Shared-Secret, but
// off-CF service-to-service callers (Authorization bearer, or the M1
// x-mint-token harness mint) are deferred to their own auth.

const SECRET = 'origin-secret-test-value'

function makeApp() {
  const app = new Hono()
  app.use('*', requireOriginSecret)
  app.get('/api/x', (c) => c.text('ok'))
  return app
}

const saved = process.env.ORIGIN_SHARED_SECRET
afterEach(() => {
  if (saved === undefined) delete process.env.ORIGIN_SHARED_SECRET
  else process.env.ORIGIN_SHARED_SECRET = saved
})

describe('requireOriginSecret (SEC-03)', () => {
  it('no-op when ORIGIN_SHARED_SECRET is unset', async () => {
    delete process.env.ORIGIN_SHARED_SECRET
    const res = await makeApp().request('/api/x')
    expect(res.status).toBe(200)
  })

  describe('armed', () => {
    beforeEach(() => {
      process.env.ORIGIN_SHARED_SECRET = SECRET
    })

    it('403s a bare browser-shaped request with no headers', async () => {
      const res = await makeApp().request('/api/x')
      expect(res.status).toBe(403)
    })

    it('allows the correct X-Origin-Shared-Secret (CF-injected)', async () => {
      const res = await makeApp().request('/api/x', { headers: { 'x-origin-shared-secret': SECRET } })
      expect(res.status).toBe(200)
    })

    it('403s a wrong secret', async () => {
      const res = await makeApp().request('/api/x', { headers: { 'x-origin-shared-secret': 'nope' } })
      expect(res.status).toBe(403)
    })

    it('defers Authorization-bearing s2s callers', async () => {
      const res = await makeApp().request('/api/x', { headers: { authorization: 'Bearer whatever' } })
      expect(res.status).toBe(200)
    })

    it('defers x-mint-token harness mint calls (M1 — no Authorization header)', async () => {
      const res = await makeApp().request('/api/x', { headers: { 'x-mint-token': 'eyJ.mint.sig' } })
      expect(res.status).toBe(200)
    })
  })
})
