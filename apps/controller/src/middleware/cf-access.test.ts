import { describe, test, expect, beforeEach } from 'bun:test'
import { generateKeyPair, SignJWT, exportJWK } from 'jose'
import {
  _resetJWKSCacheForTests,
  extractToken,
  readCfAccessConfig,
  verifyCfAccessJwt,
} from './cf-access'

// Spin up a tiny local server that serves a JWKS we control, then issue
// JWTs signed by the matching private key. This is the only way to
// integration-test the verifier without mocking jose's internals.
async function withTestIdP<T>(
  fn: (ctx: {
    teamDomain: string
    aud: string
    sign: (claims: Record<string, unknown>, overrides?: { aud?: string; iss?: string; exp?: number }) => Promise<string>
  }) => Promise<T>,
): Promise<T> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const jwk = await exportJWK(publicKey)
  jwk.kid = 'test-key-1'
  jwk.alg = 'RS256'
  jwk.use = 'sig'

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/cdn-cgi/access/certs') {
        return new Response(JSON.stringify({ keys: [jwk] }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })

  const teamDomain = `http://localhost:${server.port}`
  const aud = 'aud-tag-fixture'

  try {
    return await fn({
      teamDomain,
      aud,
      async sign(claims, overrides) {
        const exp = overrides?.exp ?? Math.floor(Date.now() / 1000) + 60
        return await new SignJWT(claims)
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
          .setIssuer(overrides?.iss ?? teamDomain)
          .setAudience(overrides?.aud ?? aud)
          .setExpirationTime(exp)
          .setIssuedAt()
          .sign(privateKey)
      },
    })
  } finally {
    server.stop(true)
  }
}

describe('readCfAccessConfig', () => {
  const origTeam = process.env.CF_ACCESS_TEAM_DOMAIN
  const origAud = process.env.CF_ACCESS_AUD
  beforeEach(() => {
    delete process.env.CF_ACCESS_TEAM_DOMAIN
    delete process.env.CF_ACCESS_AUD
  })

  test('returns null when both unset', () => {
    expect(readCfAccessConfig()).toBeNull()
  })

  test('throws when only team domain set', () => {
    process.env.CF_ACCESS_TEAM_DOMAIN = 'acme'
    expect(() => readCfAccessConfig()).toThrow(/must both be set/)
  })

  test('throws when only aud set', () => {
    process.env.CF_ACCESS_AUD = 'some-aud'
    expect(() => readCfAccessConfig()).toThrow(/must both be set/)
  })

  test('normalizes bare team name to full URL', () => {
    process.env.CF_ACCESS_TEAM_DOMAIN = 'acme'
    process.env.CF_ACCESS_AUD = 'aud-tag'
    const c = readCfAccessConfig()
    expect(c).toEqual({ teamDomain: 'https://acme.cloudflareaccess.com', aud: 'aud-tag' })
  })

  test('accepts full https URL and strips trailing slash', () => {
    process.env.CF_ACCESS_TEAM_DOMAIN = 'https://acme.cloudflareaccess.com/'
    process.env.CF_ACCESS_AUD = 'aud-tag'
    const c = readCfAccessConfig()
    expect(c?.teamDomain).toBe('https://acme.cloudflareaccess.com')
  })

  // restore for any downstream tests in the same process
  if (origTeam) process.env.CF_ACCESS_TEAM_DOMAIN = origTeam
  if (origAud) process.env.CF_ACCESS_AUD = origAud
})

describe('extractToken', () => {
  test('prefers header over cookie', () => {
    expect(extractToken('hdr-token', 'cookie-token')).toBe('hdr-token')
  })
  test('falls back to cookie when no header', () => {
    expect(extractToken(undefined, 'cookie-token')).toBe('cookie-token')
  })
  test('returns null when neither present', () => {
    expect(extractToken(undefined, undefined)).toBeNull()
  })
  test('treats empty string as missing', () => {
    expect(extractToken('', '')).toBeNull()
  })
})

describe('verifyCfAccessJwt', () => {
  beforeEach(() => _resetJWKSCacheForTests())

  test('accepts a well-formed token and returns email + sub', async () => {
    await withTestIdP(async ({ teamDomain, aud, sign }) => {
      const token = await sign({ sub: 'cf-sub-1', email: 'alice@example.com' })
      const claims = await verifyCfAccessJwt(token, { teamDomain, aud })
      expect(claims).toEqual({ sub: 'cf-sub-1', email: 'alice@example.com' })
    })
  })

  test('rejects token with wrong aud', async () => {
    await withTestIdP(async ({ teamDomain, aud, sign }) => {
      const token = await sign({ sub: 'cf-sub-1', email: 'a@x' }, { aud: 'different-aud' })
      await expect(verifyCfAccessJwt(token, { teamDomain, aud })).rejects.toThrow()
    })
  })

  test('rejects token with wrong issuer', async () => {
    await withTestIdP(async ({ teamDomain, aud, sign }) => {
      const token = await sign({ sub: 'cf-sub-1', email: 'a@x' }, { iss: 'https://attacker.example' })
      await expect(verifyCfAccessJwt(token, { teamDomain, aud })).rejects.toThrow()
    })
  })

  test('rejects expired token', async () => {
    await withTestIdP(async ({ teamDomain, aud, sign }) => {
      const token = await sign({ sub: 'cf-sub-1', email: 'a@x' }, { exp: Math.floor(Date.now() / 1000) - 10 })
      await expect(verifyCfAccessJwt(token, { teamDomain, aud })).rejects.toThrow()
    })
  })

  test('rejects token missing email claim', async () => {
    await withTestIdP(async ({ teamDomain, aud, sign }) => {
      const token = await sign({ sub: 'cf-sub-1' })
      await expect(verifyCfAccessJwt(token, { teamDomain, aud })).rejects.toThrow(/email/)
    })
  })
})
