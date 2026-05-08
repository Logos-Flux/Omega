/**
 * RAG config plumbing. The four interesting cases are unset/set/half-set
 * and trailing-slash normalisation; that's the entire contract this
 * helper offers to PR 7's proxy routes and the harness rag.search skill.
 *
 * Run with: bun test apps/controller/src/lib/rag-config.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { _resetWarnLatchForTests, getRagConfig, isRagEnabled } from './rag-config'

const ORIGINAL_API_URL = process.env.RAG_API_URL
const ORIGINAL_SERVICE_TOKEN = process.env.RAG_SERVICE_TOKEN

beforeEach(() => {
  delete process.env.RAG_API_URL
  delete process.env.RAG_SERVICE_TOKEN
  _resetWarnLatchForTests()
})

afterEach(() => {
  if (ORIGINAL_API_URL === undefined) delete process.env.RAG_API_URL
  else process.env.RAG_API_URL = ORIGINAL_API_URL
  if (ORIGINAL_SERVICE_TOKEN === undefined) delete process.env.RAG_SERVICE_TOKEN
  else process.env.RAG_SERVICE_TOKEN = ORIGINAL_SERVICE_TOKEN
})

describe('getRagConfig', () => {
  it('returns null when both vars are unset (RAG disabled)', () => {
    expect(getRagConfig()).toBeNull()
    expect(isRagEnabled()).toBe(false)
  })

  it('returns the config when both vars are set', () => {
    process.env.RAG_API_URL = 'https://rag.example.com'
    process.env.RAG_SERVICE_TOKEN = 'tok-123'
    expect(getRagConfig()).toEqual({ apiUrl: 'https://rag.example.com', serviceToken: 'tok-123' })
    expect(isRagEnabled()).toBe(true)
  })

  it('strips a trailing slash from RAG_API_URL', () => {
    process.env.RAG_API_URL = 'https://rag.example.com/'
    process.env.RAG_SERVICE_TOKEN = 'tok-123'
    expect(getRagConfig()?.apiUrl).toBe('https://rag.example.com')
  })

  it('returns null when only RAG_API_URL is set (misconfig)', () => {
    process.env.RAG_API_URL = 'https://rag.example.com'
    expect(getRagConfig()).toBeNull()
  })

  it('returns null when only RAG_SERVICE_TOKEN is set (misconfig)', () => {
    process.env.RAG_SERVICE_TOKEN = 'tok-123'
    expect(getRagConfig()).toBeNull()
  })

  it('treats whitespace-only values as unset', () => {
    process.env.RAG_API_URL = '   '
    process.env.RAG_SERVICE_TOKEN = '   '
    expect(getRagConfig()).toBeNull()
  })
})
