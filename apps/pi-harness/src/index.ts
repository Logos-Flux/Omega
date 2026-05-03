import { listConversations, readConversation, WORKSPACE_ROOT } from './memory'
import { ensureWorkspace } from './workspace'
import { run as runEngine } from './engine'
import type { IncomingSend, Outgoing } from './types'
import { readSkill, scanSkills } from './skills'
import { listUploads, readUpload, saveUpload, uploadPath } from './uploads'
import { harnessJwtConfigured, tryVerify } from './jwt'
import { readShimConfig, startGccliShim } from './gccli-shim'
import { handleProfileRoute } from './profile-routes'
import {
  cancelTurn,
  rewindConversation,
  type InFlightTurns,
} from './control'
import { existsSync } from 'node:fs'

// Refuse to run with a placeholder HARNESS_JWT_SECRET in production. The
// docker-compose default is `dev-only-change-me-32-bytes-hex`; tolerating
// it in prod would mean every operator who forgot to set the env var ships
// with an attacker-known signing key. We check here (rather than in jwt.ts,
// which is intentionally kept tiny + outside this remediation's scope) so
// the failure happens at startup before any request is served.
{
  const sec = process.env.HARNESS_JWT_SECRET ?? ''
  if (process.env.NODE_ENV === 'production' && sec.startsWith('dev-only-')) {
    throw new Error(
      '[harness] HARNESS_JWT_SECRET is a dev-only placeholder but NODE_ENV=production. ' +
        'Generate a real secret with `openssl rand -hex 32` and set HARNESS_JWT_SECRET.',
    )
  }
}

// CORS: env-driven allowlist. ALLOWED_ORIGINS is a CSV; if unset we fall back
// to `*` (and warn at startup) so single-machine docker-compose / dev setups
// keep working without ceremony, but production deploys behind a real origin
// should set it. Note: pi-harness uses raw Bun.serve, so headers are computed
// per-request rather than via Hono middleware.
const ALLOWED_ORIGINS_RAW = (process.env.ALLOWED_ORIGINS ?? '').trim()
const ALLOWED_ORIGINS_LIST = ALLOWED_ORIGINS_RAW
  ? ALLOWED_ORIGINS_RAW.split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0)
  : null
if (!ALLOWED_ORIGINS_LIST) {
  console.warn(
    '[harness] ALLOWED_ORIGINS not set — falling back to wildcard `*`. ' +
      'For production deploys, set ALLOWED_ORIGINS to a CSV of allowed origins.',
  )
}

const STATIC_CORS_HEADERS = {
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-max-age': '86400',
}

// Build the CORS header set for one inbound request. When ALLOWED_ORIGINS
// is unset we fall back to a wildcard so single-machine docker-compose setups
// keep working; when it IS set, we only echo Origin (and opt into credentials
// + Vary: Origin) for matched callers. Unmatched cross-origin callers get no
// Access-Control-Allow-Origin header at all and the browser blocks them.
function corsHeadersForReq(req: Request | null): Record<string, string> {
  const headers: Record<string, string> = { ...STATIC_CORS_HEADERS }
  if (!ALLOWED_ORIGINS_LIST) {
    headers['access-control-allow-origin'] = '*'
    return headers
  }
  const origin = req?.headers.get('origin') ?? ''
  if (origin && ALLOWED_ORIGINS_LIST.includes(origin)) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-credentials'] = 'true'
    headers['vary'] = 'Origin'
  }
  return headers
}

function withCors(res: Response, req: Request | null = null): Response {
  for (const [k, v] of Object.entries(corsHeadersForReq(req))) res.headers.set(k, v)
  return res
}

function jsonCors(data: unknown, init?: ResponseInit, req: Request | null = null): Response {
  return withCors(Response.json(data, init), req)
}

function unauth(req: Request, message = 'unauthenticated'): Response {
  return jsonCors({ error: message }, { status: 401 }, req)
}

function forbidden(req: Request, message = 'forbidden'): Response {
  return jsonCors({ error: message }, { status: 403 }, req)
}

const PORT = Number(process.env.PORT ?? 8080)

await ensureWorkspace()
console.log(`[harness] workspace=${WORKSPACE_ROOT}`)
if (!harnessJwtConfigured) {
  console.error('[harness] HARNESS_JWT_SECRET not set — every request will be rejected')
} else {
  console.log('[harness] JWT verification enabled')
}
{
  const { skills, issues } = await scanSkills()
  console.log(`[harness] loaded ${skills.length} skill(s): ${skills.map((s) => s.name).join(', ') || '(none)'}`)
  for (const issue of issues) {
    console.warn(`[harness] skill skipped: ${issue.path} — ${issue.reason}`)
  }
}

// gccli/gdcli/gmcli boot shim (Phase 0.B.5). Configured iff the
// controller env vars are present. The shim itself is idempotent on
// userId, so we kick it off lazily on the first authenticated request.
// Email is sourced from the controller's mint response per request.
const SHIM_CONFIG = readShimConfig()
if (!SHIM_CONFIG) {
  console.log(
    '[harness] gccli shim disabled (CONTROLLER_BASE_URL / CONTROLLER_SERVICE_TOKEN not set)',
  )
} else {
  console.log('[harness] gccli shim configured (email comes from controller)')
}

interface WSData {
  remote: string
  userId: string
  sessionId: string
  // X.C — per-WS in-flight turn registry. AbortControllers are added
  // when a `send` frame starts a turn and removed when run() resolves.
  // Cancel/rewind frames look up entries here. Lives on `data` so the
  // map is GC'd when the socket closes — no global state to leak.
  inflight: InFlightTurns
}

const server = Bun.serve<WSData, never>({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(req, srv) {
    const url = new URL(req.url)

    if (req.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), req)
    }

    // Public endpoints — no auth.
    if (url.pathname === '/healthz') {
      return jsonCors({ status: 'ok', workspace: WORKSPACE_ROOT }, undefined, req)
    }
    if (url.pathname === '/' || url.pathname === '/info') {
      return jsonCors({ name: 'Omega Pi Harness', version: '0.1.0' }, undefined, req)
    }

    // Everything below requires a verified token. Token comes from either
    // an Authorization: Bearer header (fetch) or a ?token= query string
    // (<a> download links + WS upgrade, which can't set headers in browsers).
    const claims = tryVerify(req)
    if (!claims) return unauth(req)

    // First-authenticated-request side effect: kick off the gccli shim
    // for this user. `startGccliShim` is idempotent on userId so the
    // mint+write only fires once per harness lifetime; subsequent
    // calls are no-ops. Errors don't block the request.
    if (SHIM_CONFIG) {
      void startGccliShim({ userId: claims.userId, config: SHIM_CONFIG })
    }

    // Path-scoped check: any endpoint that names a sessionId in its URL
    // must match the sessionId in the verified token. Stops a holder of
    // session A's token from peeking at session B's data.
    const requireSid = (sid: string): Response | null =>
      sid === claims.sessionId ? null : forbidden(req, 'session mismatch')

    if (url.pathname === '/conversations') {
      return jsonCors({ ids: await listConversations() }, undefined, req)
    }
    if (url.pathname.startsWith('/conversations/')) {
      const id = url.pathname.replace(/^\/conversations\//, '')
      const bad = requireSid(id)
      if (bad) return bad
      return jsonCors({ id, lines: await readConversation(id) }, undefined, req)
    }
    if (url.pathname === '/skills') {
      const validate = url.searchParams.has('validate')
      const { skills, issues } = await scanSkills()
      if (validate) {
        return jsonCors(
          {
            skills: skills.map((s) => ({ name: s.name, description: s.description })),
            issues,
          },
          undefined,
          req,
        )
      }
      return jsonCors(
        {
          skills: skills.map((s) => ({ name: s.name, description: s.description })),
        },
        undefined,
        req,
      )
    }
    if (url.pathname.startsWith('/skills/')) {
      const name = url.pathname.replace(/^\/skills\//, '')
      const body = await readSkill(name)
      if (!body) return jsonCors({ error: 'not found' }, { status: 404 }, req)
      return jsonCors({ name, body }, undefined, req)
    }

    // Binary file download endpoint — separate from /uploads/:id/:name
    // (which returns a JSON wrapper with utf-8 body) so we can serve PDFs,
    // images, etc. with the right content-type.
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      const rest = url.pathname.replace(/^\/files\//, '')
      const slash = rest.indexOf('/')
      if (slash === -1) {
        return withCors(new Response('expected /files/<sessionId>/<filename>', { status: 400 }), req)
      }
      const sessionId = rest.slice(0, slash)
      const bad = requireSid(sessionId)
      if (bad) return bad
      const filename = decodeURIComponent(rest.slice(slash + 1))
      try {
        const path = uploadPath(sessionId, filename)
        if (!existsSync(path)) return withCors(new Response('not found', { status: 404 }), req)
        const file = Bun.file(path)
        const headers = new Headers(corsHeadersForReq(req))
        headers.set('content-type', file.type || 'application/octet-stream')
        headers.set('content-disposition', `attachment; filename="${filename}"`)
        return new Response(file, { headers })
      } catch (e) {
        return withCors(new Response((e as Error).message, { status: 400 }), req)
      }
    }

    if (req.method === 'POST' && url.pathname === '/uploads') {
      try {
        const form = await req.formData()
        const sessionId = String(form.get('sessionId') ?? '')
        const file = form.get('file')
        if (!sessionId || !(file instanceof File)) {
          return jsonCors({ error: 'expected sessionId + file fields' }, { status: 400 }, req)
        }
        const bad = requireSid(sessionId)
        if (bad) return bad
        const info = await saveUpload(sessionId, file)
        return jsonCors({ uploaded: info }, undefined, req)
      } catch (e) {
        return jsonCors({ error: (e as Error).message }, { status: 400 }, req)
      }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
      const rest = url.pathname.replace(/^\/uploads\//, '')
      const slash = rest.indexOf('/')
      if (slash === -1) {
        const bad = requireSid(rest)
        if (bad) return bad
        try {
          return jsonCors({ uploads: await listUploads(rest) }, undefined, req)
        } catch (e) {
          return jsonCors({ error: (e as Error).message }, { status: 400 }, req)
        }
      }
      const sessionId = rest.slice(0, slash)
      const bad = requireSid(sessionId)
      if (bad) return bad
      const filename = rest.slice(slash + 1)
      try {
        const body = await readUpload(sessionId, filename)
        if (body === null) return jsonCors({ error: 'not found' }, { status: 404 }, req)
        return jsonCors({ filename, body }, undefined, req)
      } catch (e) {
        return jsonCors({ error: (e as Error).message }, { status: 400 }, req)
      }
    }

    // Profile endpoints — JWT-gated, sessionId-agnostic. The profile is
    // per-user (one /workspace/profile.json per sprite), not per-session,
    // so we don't enforce sessionId here. Logic lives in
    // src/profile-routes.ts so it stays unit-testable without booting
    // the WebSocket server.
    {
      const profileResult = await handleProfileRoute(req)
      if (profileResult) {
        return jsonCors(profileResult.body, { status: profileResult.status }, req)
      }
    }

    if (
      url.pathname === '/ws' &&
      srv.upgrade(req, {
        data: {
          remote: req.headers.get('x-forwarded-for') ?? 'unknown',
          userId: claims.userId,
          sessionId: claims.sessionId,
          inflight: new Map() as InFlightTurns,
        },
      })
    ) {
      return
    }

    return withCors(new Response('not found', { status: 404 }), req)
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: 'hello', version: '0.1.0', workspace: WORKSPACE_ROOT }))
    },
    async message(ws, raw) {
      let parsed: unknown
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(new TextDecoder().decode(raw))
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'invalid json' }))
        return
      }
      const msg = parsed as { type?: string }
      const emit = (out: Outgoing) => ws.send(JSON.stringify(out))

      // X.C.1 — cancel frame. Tear down any in-flight turn whose id
      // matches; the engine's catch handler emits the trailing `done`
      // with `cancelled: true`. Unknown ids are silently no-op'd
      // (the turn already finished, or never started).
      if (msg.type === 'cancel') {
        const cancel = msg as { id?: unknown }
        if (typeof cancel.id !== 'string' || !cancel.id) {
          ws.send(JSON.stringify({ type: 'error', message: 'cancel: missing id' }))
          return
        }
        cancelTurn(cancel.id, ws.data.inflight, emit)
        return
      }

      // X.C.2 — rewind frame. Cascades cancel (so no engine.run is
      // mid-append) then truncates conversation.jsonl. Confirmation
      // event lets the frontend know it can re-render from the
      // truncated file; an error event covers unknown message ids.
      if (msg.type === 'rewind') {
        const rw = msg as { id?: unknown; toMessageId?: unknown }
        if (typeof rw.toMessageId !== 'string' || !rw.toMessageId) {
          ws.send(JSON.stringify({ type: 'error', message: 'rewind: missing toMessageId' }))
          return
        }
        const correlationId = typeof rw.id === 'string' ? rw.id : undefined
        const result = await rewindConversation(
          ws.data.sessionId,
          rw.toMessageId,
          ws.data.inflight,
        )
        if (!result.ok) {
          emit({
            type: 'error',
            id: correlationId ?? rw.toMessageId,
            message: 'message not found',
          })
          return
        }
        emit({
          type: 'rewind_done',
          ...(correlationId ? { id: correlationId } : {}),
          toMessageId: rw.toMessageId,
        })
        return
      }

      if (msg.type !== 'send') {
        ws.send(JSON.stringify({ type: 'error', message: `unknown type: ${msg.type}` }))
        return
      }
      const send = msg as unknown as IncomingSend
      if (!send.id || !send.sessionId || typeof send.content !== 'string') {
        ws.send(JSON.stringify({ type: 'error', message: 'missing id, sessionId, or content' }))
        return
      }
      if (send.sessionId !== ws.data.sessionId) {
        ws.send(JSON.stringify({ type: 'error', message: 'sessionId mismatch' }))
        return
      }

      // X.C.1 — register the turn's AbortController before kicking off
      // engine.run so a cancel frame that arrives mid-stream can find
      // and abort it. Use try/finally to guarantee the entry is
      // removed regardless of how run() exits (success, error, or
      // cancellation).
      const ctrl = new AbortController()
      ws.data.inflight.set(send.id, ctrl)
      try {
        await runEngine(send, emit, {
          userId: ws.data.userId,
          signal: ctrl.signal,
        })
      } finally {
        ws.data.inflight.delete(send.id)
      }
    },
    close(ws) {
      // X.C.1 — abort anything still running on this connection.
      // Without this, a streamText loop could keep burning tokens
      // after the user navigated away.
      for (const ctrl of ws.data.inflight.values()) {
        ctrl.abort()
      }
      ws.data.inflight.clear()
    },
  },
})

console.log(`[harness] listening on http://localhost:${server.port} (ws /ws)`)
