import { createHmac, timingSafeEqual } from 'node:crypto'

const SECRET = process.env.HARNESS_JWT_SECRET ?? ''

export interface SessionTokenClaims {
  userId: string
  sessionId: string
  iat: number
  exp: number
}

function b64urlEncode(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8')
  return b.toString('base64url')
}

function sign(input: string): Buffer {
  if (!SECRET) throw new Error('HARNESS_JWT_SECRET not set')
  return createHmac('sha256', SECRET).update(input).digest()
}

export function signSessionToken(args: {
  userId: string
  sessionId: string
  ttlSec?: number
}): string {
  const ttl = args.ttlSec ?? 4 * 60 * 60 // 4 hours
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload: SessionTokenClaims = {
    userId: args.userId,
    sessionId: args.sessionId,
    iat: now,
    exp: now + ttl,
  }
  const head = b64urlEncode(JSON.stringify(header))
  const body = b64urlEncode(JSON.stringify(payload))
  const signing = `${head}.${body}`
  const sig = b64urlEncode(sign(signing))
  return `${signing}.${sig}`
}

export function verifySessionToken(token: string): SessionTokenClaims {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('malformed token')
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string]
  const expected = sign(`${headerB64}.${payloadB64}`)
  const provided = Buffer.from(sigB64, 'base64url')
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new Error('signature invalid')
  }
  const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as SessionTokenClaims
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error('token expired')
  if (!claims.userId || !claims.sessionId) throw new Error('token missing fields')
  return claims
}

export const harnessJwtConfigured = SECRET.length > 0
