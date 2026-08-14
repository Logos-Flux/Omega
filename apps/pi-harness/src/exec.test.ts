import { describe, expect, test, afterEach } from 'bun:test'
import { buildSandboxEnv } from './exec'

// BUG-01 — the `exec`/`shell` child env must NOT carry provider keys or OAuth
// secrets. The previous GOOGLE_/STRIPE_ prefix forwarding leaked the shared
// Gemini billing key (GOOGLE_API_KEY) and GOOGLE_OAUTH_CLIENT_SECRET into
// model-visible `env` output (and thence into conversation.jsonl).

describe('buildSandboxEnv (BUG-01)', () => {
  const touched = [
    'GOOGLE_API_KEY',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_CLIENT_ID',
    'ANTHROPIC_API_KEY',
    'HARNESS_JWT_SECRET',
    'CONTROLLER_SERVICE_TOKEN',
    'CONTROLLER_MINT_TOKEN',
    'STRIPE_SECRET_KEY',
  ]
  afterEach(() => {
    for (const k of touched) delete process.env[k]
  })

  test('does not forward provider keys or OAuth/JWT secrets to children', () => {
    process.env.GOOGLE_API_KEY = 'gemini-billing-key'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'oauth-client-secret'
    process.env.ANTHROPIC_API_KEY = 'anthropic-key'
    process.env.HARNESS_JWT_SECRET = 'jwt-secret'
    process.env.CONTROLLER_SERVICE_TOKEN = 'service-token'
    process.env.CONTROLLER_MINT_TOKEN = 'per-sprite-mint-token'
    process.env.STRIPE_SECRET_KEY = 'sk_live_x'

    const env = buildSandboxEnv()

    expect(env.GOOGLE_API_KEY).toBeUndefined()
    expect(env.GOOGLE_OAUTH_CLIENT_SECRET).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.HARNESS_JWT_SECRET).toBeUndefined()
    expect(env.CONTROLLER_SERVICE_TOKEN).toBeUndefined()
    // SEC-01 — the per-sprite mint token must not leak to shell children either.
    expect(env.CONTROLLER_MINT_TOKEN).toBeUndefined()
    expect(env.STRIPE_SECRET_KEY).toBeUndefined()
    // No value in the env should equal a known secret.
    for (const v of Object.values(env)) {
      expect(v).not.toBe('gemini-billing-key')
      expect(v).not.toBe('oauth-client-secret')
    }
  })

  test('forwards the non-secret GOOGLE_OAUTH_CLIENT_ID plus PATH/HOME', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id.apps.googleusercontent.com'
    const env = buildSandboxEnv()
    expect(env.GOOGLE_OAUTH_CLIENT_ID).toBe('client-id.apps.googleusercontent.com')
    expect(env.PATH).toContain('/usr/bin')
    expect(env.HOME.length).toBeGreaterThan(0)
  })
})
