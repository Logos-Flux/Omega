import { createHmac, timingSafeEqual } from 'node:crypto'

const SECRET = process.env.HARNESS_JWT_SECRET ?? ''

export const harnessJwtConfigured = SECRET.length > 0

export interface SessionTokenClaims {
  userId: string
  sessionId: string
  iat: number
  exp: number
}

function sign(input: string): Buffer {
  if (!SECRET) throw new Error('HARNESS_JWT_SECRET not set')
  return createHmac('sha256', SECRET).update(input).digest()
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

// Pull a token off either an Authorization: Bearer header or a `?token=`
// query string. The query-string variant exists because <a> download links
// can't set headers — `/files/...` URLs need to embed the token.
export function extractToken(req: Request): string | null {
  const auth = req.headers.get('authorization')
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth)
    if (m) return m[1]!
  }
  const url = new URL(req.url)
  const q = url.searchParams.get('token')
  if (q) return q
  return null
}

export function tryVerify(req: Request): SessionTokenClaims | null {
  const token = extractToken(req)
  if (!token) return null
  try {
    return verifySessionToken(token)
  } catch {
    return null
  }
}
