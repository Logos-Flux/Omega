// Memory HTTP routes (#5). Make the persistent memory store the agent
// writes (via the write_memory tool, slot-4 injection) visible and
// editable to the user in Settings. One shared freeform-markdown store —
// /workspace/memory/_global.md — no per-scope partitioning.
//
//   GET    /memory  → { memory: string }   (empty string when unset)
//   PUT    /memory  → { ok }   replace the whole store
//   DELETE /memory  → { ok }   clear it
//
// Pulled out of index.ts (like profile-routes/skills-routes) so it's
// unit-testable without booting the server. JWT-gated by the caller;
// per-user (one store per sprite), so no sessionId check.

import { readSystemMemory, writeSystemMemory } from './memory'

export interface RouteResult {
  status: number
  body: unknown
}

export async function handleMemoryRoute(req: Request): Promise<RouteResult | null> {
  const url = new URL(req.url)
  if (url.pathname !== '/memory') return null

  if (req.method === 'GET') {
    return { status: 200, body: { memory: (await readSystemMemory()) ?? '' } }
  }

  if (req.method === 'PUT') {
    let parsed: unknown
    try {
      parsed = await req.json()
    } catch {
      return { status: 400, body: { error: 'invalid json' } }
    }
    const wrapped = parsed as { memory?: unknown }
    if (!wrapped || typeof wrapped !== 'object' || typeof wrapped.memory !== 'string') {
      return { status: 400, body: { error: 'expected { memory: string }' } }
    }
    await writeSystemMemory(wrapped.memory)
    return { status: 200, body: { ok: true, bytes: wrapped.memory.length } }
  }

  if (req.method === 'DELETE') {
    await writeSystemMemory('')
    return { status: 200, body: { ok: true } }
  }

  return null
}
