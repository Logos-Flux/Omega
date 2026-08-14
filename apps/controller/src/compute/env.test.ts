/**
 * Verifies the env block injected into spawned pi-harness containers.
 * The high-stakes assertion is that RAG_API_URL + RAG_SERVICE_TOKEN
 * actually flow through — the harness's rag_search tool reads them
 * out of its own env and silently skips registration if they're
 * unset, so a missing forwarding line is a silent feature regression.
 *
 * Run with: bun test apps/controller/src/compute/env.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { dockerHarnessEnv } from './env'

const KEYS_TO_SAVE = [
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'PERPLEXITY_API_KEY',
  'DEEPSEEK_API_KEY',
  'IDEOGRAM_API_KEY',
  'HARNESS_JWT_SECRET',
  'RAG_API_URL',
  'RAG_SERVICE_TOKEN',
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of KEYS_TO_SAVE) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of KEYS_TO_SAVE) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('dockerHarnessEnv', () => {
  it('forwards provider keys when they are set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    process.env.GOOGLE_API_KEY = 'goog-test'
    process.env.DEEPSEEK_API_KEY = 'sk-ds-test'
    process.env.IDEOGRAM_API_KEY = 'ideo-test'
    process.env.HARNESS_JWT_SECRET = 'jwt-secret'
    const env = dockerHarnessEnv()
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test')
    expect(env.GOOGLE_API_KEY).toBe('goog-test')
    expect(env.DEEPSEEK_API_KEY).toBe('sk-ds-test')
    expect(env.IDEOGRAM_API_KEY).toBe('ideo-test')
    expect(env.HARNESS_JWT_SECRET).toBe('jwt-secret')
  })

  it('forwards RAG_API_URL + RAG_SERVICE_TOKEN to the harness', () => {
    process.env.RAG_API_URL = 'http://rag-api:3100'
    process.env.RAG_SERVICE_TOKEN = 'tok-secret'
    const env = dockerHarnessEnv()
    expect(env.RAG_API_URL).toBe('http://rag-api:3100')
    expect(env.RAG_SERVICE_TOKEN).toBe('tok-secret')
  })

  it('passes RAG_* through as undefined when unset (harness self-disables)', () => {
    const env = dockerHarnessEnv()
    expect(env.RAG_API_URL).toBeUndefined()
    expect(env.RAG_SERVICE_TOKEN).toBeUndefined()
  })

  it('always sets WORKSPACE_ROOT and PORT to fixed values', () => {
    const env = dockerHarnessEnv()
    expect(env.WORKSPACE_ROOT).toBe('/workspace')
    expect(env.PORT).toBe('8080')
  })

  it('reads env lazily — values set after first call are visible on the next', () => {
    expect(dockerHarnessEnv().RAG_API_URL).toBeUndefined()
    process.env.RAG_API_URL = 'http://later'
    expect(dockerHarnessEnv().RAG_API_URL).toBe('http://later')
  })
})
