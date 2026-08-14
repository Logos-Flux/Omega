import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { HARNESS_FORWARDED_ENV, forwardedHarnessEnv } from './harness-env'
import { dockerHarnessEnv } from '../compute/env'

// OPS-25 — the two harness env builders (Sprites bootstrap + Docker provider)
// MUST forward the same var set; drift silently disables a feature on one
// backend only (the RAG_API_URL incident). Both are now defined as
// `{ WORKSPACE_ROOT, PORT, ...forwardedHarnessEnv() }`, so this list is the
// single source of truth and these tests pin the contract.
//
// We intentionally do NOT import defaultResolveHarnessEnv from ./bootstrap
// here: session.test.ts installs a process-global `mock.module('../lib/
// bootstrap')` whose stub omits that export, which would break this import.
// The Docker builder (compute/env.ts) is the one that historically drifted,
// and both builders share the exact same expression, so asserting the Docker
// builder against the canonical set fully covers the contract.

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of HARNESS_FORWARDED_ENV) {
    saved[k] = process.env[k]
    process.env[k] = `val-${k}`
  }
})

afterEach(() => {
  for (const k of HARNESS_FORWARDED_ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('harness env parity (OPS-25)', () => {
  it('the Docker builder forwards exactly the canonical set + WORKSPACE_ROOT/PORT', () => {
    const expected = { WORKSPACE_ROOT: '/workspace', PORT: '8080', ...forwardedHarnessEnv() }
    expect(dockerHarnessEnv()).toEqual(expected)
  })

  it('forwards every var in HARNESS_FORWARDED_ENV when set', () => {
    const env = dockerHarnessEnv()
    for (const k of HARNESS_FORWARDED_ENV) {
      expect(env[k]).toBe(`val-${k}`)
    }
  })

  it('drops unset vars rather than forwarding empty strings', () => {
    delete process.env.RAG_API_URL
    const env = forwardedHarnessEnv()
    expect('RAG_API_URL' in env).toBe(false)
  })

  // SEC-01 (M1) regression guard — the fleet-shared CONTROLLER_SERVICE_TOKEN
  // must NEVER be forwarded into a Sprite (it was the cross-user Google-mint
  // vector; sprites now mint via a per-user CONTROLLER_MINT_TOKEN). A prior
  // OPS-25 unification accidentally re-added it to this list; this pins it out.
  it('never forwards CONTROLLER_SERVICE_TOKEN (SEC-01)', () => {
    expect(HARNESS_FORWARDED_ENV).not.toContain('CONTROLLER_SERVICE_TOKEN')
    process.env.CONTROLLER_SERVICE_TOKEN = 'should-not-leak'
    expect('CONTROLLER_SERVICE_TOKEN' in forwardedHarnessEnv()).toBe(false)
    expect('CONTROLLER_SERVICE_TOKEN' in dockerHarnessEnv()).toBe(false)
    delete process.env.CONTROLLER_SERVICE_TOKEN
  })
})
