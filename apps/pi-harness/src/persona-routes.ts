// Persona HTTP routes (#6). A cosmetic preset picker: switching the active
// persona swaps the assembler's slot-5 system-prompt body. Persona skill
// allow-lists / memory scoping stay inert — skills are governed by the
// flat #3 toggle, not personas.
//
//   GET /personas  → { personas: [{name, label}], active }
//   PUT /persona   → { name }  → validates the persona exists, then
//                    persists state.json::activePersona; { ok, active }
//
// Pulled out of index.ts for unit-testability. JWT-gated by the caller;
// per-user (one state.json per sprite), so no sessionId check.

import { PersonaRegistry, type Persona } from './personas'
import { readState, patchState } from './state'

export interface RouteResult {
  status: number
  body: unknown
}

// A short, human label for the picker: the persona's first non-empty body
// line (minus markdown emphasis), or a title-cased name when the body is
// empty (the default persona ships an empty body).
function labelFor(p: Persona): string {
  const firstLine = p.body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!firstLine) {
    return p.name.charAt(0).toUpperCase() + p.name.slice(1)
  }
  const cleaned = firstLine.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim()
  return cleaned.length > 100 ? cleaned.slice(0, 99) + '…' : cleaned
}

export async function handlePersonaRoute(req: Request): Promise<RouteResult | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/personas' && req.method === 'GET') {
    const [personas, { activePersona }] = await Promise.all([
      PersonaRegistry.list(),
      readState(),
    ])
    return {
      status: 200,
      body: {
        personas: personas.map((p) => ({ name: p.name, label: labelFor(p) })),
        active: activePersona,
      },
    }
  }

  if (path === '/persona' && req.method === 'PUT') {
    let parsed: unknown
    try {
      parsed = await req.json()
    } catch {
      return { status: 400, body: { error: 'invalid json' } }
    }
    const wrapped = parsed as { name?: unknown }
    if (!wrapped || typeof wrapped !== 'object' || typeof wrapped.name !== 'string') {
      return { status: 400, body: { error: 'expected { name: string }' } }
    }
    const persona = await PersonaRegistry.get(wrapped.name)
    if (!persona) {
      return { status: 404, body: { error: `unknown persona: ${wrapped.name}` } }
    }
    await patchState({ activePersona: persona.name })
    return { status: 200, body: { ok: true, active: persona.name } }
  }

  return null
}
