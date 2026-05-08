// /api/rag/* — browser-facing proxy to rag-api.
//
// Three concerns the chat-frontend needs that we don't want exposing
// directly: the service bearer (must never reach the browser), the
// RAG hostname (rag-api may live on an internal network not reachable
// from the user's browser), and the user_id binding (the chat side's
// authenticated user MUST be the user_id sent to rag-api — we can't
// trust a body field for that).
//
// The proxy sits in the controller because the controller already has
// the authenticated session middleware and the RAG config envs. Routes:
//
//   GET  /api/rag/enabled            — feature flag for the chat UI
//   POST /api/rag/sync               — kick off a Drive crawl for the
//                                      session user
//   GET  /api/rag/status             — last_synced_at, in-flight job,
//                                      file_count, my_ai_folder_status
//   POST /api/rag/forget             — drop the user's user_file_access
//                                      rows + GC orphan rag.files
//
// All forward to rag-api's `/api/v1/users/*` shape, replacing the
// session user's id for the `user_id` field/path.

import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { requireSession } from '../middleware/session'
import { getRagConfig, isRagEnabled, type RagConfig } from '../lib/rag-config'

declare module 'hono' {
  interface ContextVariableMap {
    rag: RagConfig
  }
}

const requireRag: MiddlewareHandler = async (c, next) => {
  const cfg = getRagConfig()
  if (!cfg) return c.json({ error: 'rag is not configured' }, 503)
  c.set('rag', cfg)
  await next()
}

export const ragRoutes = new Hono()

// /enabled — ungated feature flag. The chat-frontend reads this to
// decide whether to render the Connect-Drive UX at all. Trivial info
// disclosure (whether the operator has wired up RAG); not worth a
// session round-trip.
ragRoutes.get('/enabled', (c) => c.json({ enabled: isRagEnabled() }))

// Forward an arbitrary rag-api response back to the browser. We don't
// massage the body — rag-api already returns the JSON shape the
// frontend expects.
async function forward(res: Response): Promise<Response> {
  const text = await res.text()
  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// POST /api/rag/sync — kick off (or join) a Drive crawl. Body is
// `{ force?: boolean }`; rag-api handles idempotency (returns the
// existing job if one is queued/running unless force=true).
ragRoutes.post('/sync', requireSession, requireRag, async (c) => {
  const user = c.get('user')
  const cfg = c.get('rag')
  const body = (await c.req.json().catch(() => ({}))) as { force?: boolean }
  const res = await fetch(`${cfg.apiUrl}/api/v1/users/sync`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.serviceToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: user.id, force: body.force ?? false }),
  })
  return forward(res)
})

// GET /api/rag/status — what the polling UI hits while a sync is
// running, and on initial paint to decide between "Connect Drive",
// "Indexing…", and "X files synced N min ago" states.
ragRoutes.get('/status', requireSession, requireRag, async (c) => {
  const user = c.get('user')
  const cfg = c.get('rag')
  const res = await fetch(`${cfg.apiUrl}/api/v1/users/${user.id}/status`, {
    headers: { Authorization: `Bearer ${cfg.serviceToken}` },
  })
  return forward(res)
})

// POST /api/rag/forget — user-initiated wipe. Drops user_file_access
// rows + GCs orphan rag.files (and the corresponding RAGFlow docs).
ragRoutes.post('/forget', requireSession, requireRag, async (c) => {
  const user = c.get('user')
  const cfg = c.get('rag')
  const res = await fetch(`${cfg.apiUrl}/api/v1/users/${user.id}/forget`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.serviceToken}` },
  })
  return forward(res)
})
