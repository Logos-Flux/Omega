// Skill HTTP routes. Pulled out of src/index.ts (like profile-routes.ts)
// so they're unit-testable without booting Bun.serve. Handles:
//
//   GET  /skills            → { skills: [{name, description, enabled}], issues? }
//   GET  /skills/:name      → { name, body }    (full SKILL.md text)
//   PUT  /skills/:name      → { ok, enabled }   toggle on/off (#3)
//
// `enabled` is the flat per-user toggle (state.json::disabledSkills) —
// independent of persona skill allow-lists, which stay inert. JWT auth is
// enforced by the caller (index.ts) before these run; skills are per-user
// (one /workspace/skills tree per sprite), not per-session, so no
// sessionId check.

import { scanSkills, readSkill, userSkillsDir } from './skills'
import { readState, patchState } from './state'
import { deleteUserSkill } from './skill-write'

export interface RouteResult {
  status: number
  body: unknown
}

export async function handleSkillRoute(req: Request): Promise<RouteResult | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/skills' && req.method === 'GET') {
    const validate = url.searchParams.has('validate')
    const [{ skills, issues }, { disabledSkills }] = await Promise.all([
      scanSkills(),
      readState(),
    ])
    const disabled = new Set(disabledSkills)
    const userDir = userSkillsDir()
    const list = skills.map((s) => ({
      name: s.name,
      description: s.description,
      enabled: !disabled.has(s.name),
      // 'user' skills (agent-created or dropped into /workspace/skills) can
      // be deleted; 'baked' golden skills can't. Lets the UI show a delete
      // affordance only where it works.
      source: s.path.startsWith(userDir) ? 'user' : 'baked',
    }))
    return { status: 200, body: validate ? { skills: list, issues } : { skills: list } }
  }

  if (path.startsWith('/skills/')) {
    const name = decodeURIComponent(path.replace(/^\/skills\//, ''))

    if (req.method === 'GET') {
      const body = await readSkill(name)
      if (!body) return { status: 404, body: { error: 'not found' } }
      return { status: 200, body: { name, body } }
    }

    if (req.method === 'PUT') {
      let parsed: unknown
      try {
        parsed = await req.json()
      } catch {
        return { status: 400, body: { error: 'invalid json' } }
      }
      const wrapped = parsed as { enabled?: unknown }
      if (!wrapped || typeof wrapped !== 'object' || typeof wrapped.enabled !== 'boolean') {
        return { status: 400, body: { error: 'expected { enabled: boolean }' } }
      }
      // Only toggle skills that actually exist — catches typos and stops
      // disabledSkills accreting dead names.
      const { skills } = await scanSkills()
      if (!skills.some((s) => s.name === name)) {
        return { status: 404, body: { error: `unknown skill: ${name}` } }
      }
      const { disabledSkills } = await readState()
      const set = new Set(disabledSkills)
      if (wrapped.enabled) set.delete(name)
      else set.add(name)
      await patchState({ disabledSkills: [...set].sort() })
      return { status: 200, body: { ok: true, name, enabled: wrapped.enabled } }
    }

    if (req.method === 'DELETE') {
      // User (agent-created) skills only — baked skills can't be deleted.
      const removed = await deleteUserSkill(name)
      if (!removed) {
        return {
          status: 404,
          body: { error: `no user skill named "${name}" (built-in skills can't be deleted)` },
        }
      }
      // Drop it from the toggle set too so a re-created skill of the same
      // name doesn't inherit a stale disabled flag.
      const { disabledSkills } = await readState()
      if (disabledSkills.includes(name)) {
        await patchState({ disabledSkills: disabledSkills.filter((s) => s !== name) })
      }
      return { status: 200, body: { ok: true, name, deleted: true } }
    }
  }

  return null
}
