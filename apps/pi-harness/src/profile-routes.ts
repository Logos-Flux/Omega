// Profile HTTP routes (Phase II.A.2). Pulled out of src/index.ts so
// they can be exercised in isolation by test/profile-routes.test.ts —
// index.ts itself runs Bun.serve at module load, which is hostile to
// per-test workspace isolation. Keeping the route logic in its own
// module also means future profile-related routes (forget proposal
// history, accept-all, etc.) have a natural home.
//
// Each handler returns a Response or null. Null means "this isn't a
// profile route — let the caller try the next match." All handlers
// are JWT-gated by the caller (index.ts already verifies the token
// before invoking these); they don't enforce sessionId because the
// profile is per-user, not per-session.

import {
  acceptProfileProposal,
  listProfileProposals,
  ProfileValidationError,
  readProfile,
  rejectProfileProposal,
  writeProfile,
  type Profile,
} from './profile'

export interface RouteResult {
  status: number
  body: unknown
}

export async function handleProfileRoute(
  req: Request,
): Promise<RouteResult | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/profile') {
    if (req.method === 'GET') {
      return { status: 200, body: { profile: await readProfile() } }
    }
    if (req.method === 'PUT') {
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return { status: 400, body: { error: 'invalid json' } }
      }
      const wrapped = body as { profile?: Profile }
      if (!wrapped || typeof wrapped !== 'object' || !('profile' in wrapped)) {
        return { status: 400, body: { error: 'expected { profile: ... }' } }
      }
      try {
        await writeProfile(wrapped.profile as Profile)
        return { status: 200, body: { ok: true } }
      } catch (e) {
        if (e instanceof ProfileValidationError) {
          return { status: 400, body: { error: e.message } }
        }
        return { status: 500, body: { error: (e as Error).message } }
      }
    }
    return null
  }

  if (path === '/profile/proposals' && req.method === 'GET') {
    return { status: 200, body: { proposals: await listProfileProposals() } }
  }

  if (req.method === 'POST' && path.startsWith('/profile/proposals/')) {
    const rest = path.replace(/^\/profile\/proposals\//, '')
    const slash = rest.indexOf('/')
    if (slash === -1) {
      return {
        status: 400,
        body: { error: 'expected /profile/proposals/:id/{accept,reject}' },
      }
    }
    const id = rest.slice(0, slash)
    const action = rest.slice(slash + 1)
    try {
      if (action === 'accept') {
        await acceptProfileProposal(id)
        return { status: 200, body: { ok: true } }
      }
      if (action === 'reject') {
        await rejectProfileProposal(id)
        return { status: 200, body: { ok: true } }
      }
      return { status: 400, body: { error: `unknown action: ${action}` } }
    } catch (e) {
      if (e instanceof ProfileValidationError) {
        // accept/reject use ProfileValidationError to signal "not found".
        // Distinguish the not-found case from schema errors by message.
        const status = e.message.includes('not found') ? 404 : 400
        return { status, body: { error: e.message } }
      }
      return { status: 500, body: { error: (e as Error).message } }
    }
  }

  return null
}
