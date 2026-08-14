// Cloudflare Access JWT verifier.
//
// When `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are set, the service
// verifies the JWT that Cloudflare Access injects on every authenticated
// request and uses the claims (`email`, `sub`) as the user identity
// instead of falling back to the single-user stub in `session.ts`.
//
// This file is the CANONICAL CF Access verifier. It is kept
// byte-identical across chat-api, controller, intake, brand-id, and
// weechat-api; the per-app `session.ts` glue imports these functions.
// Do not edit a copy in place — change it here and re-sync (the shared nav
// repo's `scripts/check-cf-access-drift.sh` enforces this).
//
// Wire format: the JWT arrives in the `Cf-Access-Jwt-Assertion` header.
// Cloudflare also sets a `CF_Authorization` cookie; we accept that as a
// fallback for browser flows that don't (or can't) round-trip the header.
//
// Verification uses the team's public JWKS at
// `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. The
// `createRemoteJWKSet` helper from `jose` handles JWKS caching, rotation,
// and signature validation. We additionally check `aud` against the
// configured Access application AUD and `iss` against the team domain.
//
// On verification failure the middleware returns 401 with
// `{ error: 'unauthenticated' }`. We intentionally do not return a more
// descriptive error: an attacker probing the endpoint shouldn't learn
// whether they're missing a header, presenting an expired token, or
// failing AUD validation.
//
// Operator notes:
// - `CF_ACCESS_TEAM_DOMAIN` is the bare team name (e.g. `acme`), the host
//   part of `https://acme.cloudflareaccess.com`. We also accept a full
//   `https://...` URL for convenience.
// - `CF_ACCESS_AUD` is the application AUD tag from the Cloudflare
//   dashboard (Access > Applications > <app> > Overview).
// - If only one of the two is set, that's a misconfiguration; we fail
//   closed (every request returns 401) rather than silently dropping to
//   the single-user stub, so it's loud during deploy.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

export interface CfAccessClaims {
  email: string
  sub: string
}

export interface CfAccessConfig {
  teamDomain: string
  aud: string
}

export function readCfAccessConfig(): CfAccessConfig | null {
  const teamRaw = process.env.CF_ACCESS_TEAM_DOMAIN?.trim()
  const aud = process.env.CF_ACCESS_AUD?.trim()
  if (!teamRaw && !aud) return null
  if (!teamRaw || !aud) {
    throw new Error(
      'CF Access misconfigured: CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must both be set, or both unset.',
    )
  }
  const teamDomain = normalizeTeamDomain(teamRaw)
  return { teamDomain, aud }
}

function normalizeTeamDomain(raw: string): string {
  // Accept either `acme` or `https://acme.cloudflareaccess.com` (with or
  // without trailing slash).
  const trimmed = raw.replace(/\/+$/, '')
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }
  return `https://${trimmed}.cloudflareaccess.com`
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function getJWKS(teamDomain: string) {
  let jwks = jwksCache.get(teamDomain)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`))
    jwksCache.set(teamDomain, jwks)
  }
  return jwks
}

export function extractToken(headerVal: string | undefined, cookieVal: string | undefined): string | null {
  if (headerVal && headerVal.length > 0) return headerVal
  if (cookieVal && cookieVal.length > 0) return cookieVal
  return null
}

export async function verifyCfAccessJwt(token: string, config: CfAccessConfig): Promise<CfAccessClaims> {
  const jwks = getJWKS(config.teamDomain)
  const { payload } = await jwtVerify(token, jwks, {
    issuer: config.teamDomain,
    audience: config.aud,
  })
  return claimsFromPayload(payload)
}

function claimsFromPayload(payload: JWTPayload): CfAccessClaims {
  const sub = typeof payload.sub === 'string' ? payload.sub : null
  const emailRaw = (payload as { email?: unknown }).email
  const email = typeof emailRaw === 'string' ? emailRaw : null
  if (!sub) throw new Error('cf-access: missing sub claim')
  if (!email) throw new Error('cf-access: missing email claim')
  return { sub, email }
}

// Test-only: used by cf-access.test.ts to reset between tests.
export function _resetJWKSCacheForTests(): void {
  jwksCache.clear()
}
