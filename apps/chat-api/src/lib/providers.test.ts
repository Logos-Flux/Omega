/**
 * Tests for toolsForProvider. The interesting cases are:
 *   - rag_search appears iff RAG env is set AND provider supports
 *     custom function calls (excludes Perplexity — @ai-sdk/perplexity
 *     drops `tools` before reaching the Sonar API)
 *   - web_search / google_search are still wired per-provider
 *   - returns undefined when nothing is wired (so the AI SDK doesn't
 *     emit an empty `tools: {}` that some providers reject)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { toolsForProvider } from './providers'

const ORIGINAL_API_URL = process.env.RAG_API_URL
const ORIGINAL_SERVICE_TOKEN = process.env.RAG_SERVICE_TOKEN

beforeEach(() => {
  delete process.env.RAG_API_URL
  delete process.env.RAG_SERVICE_TOKEN
})

afterEach(() => {
  if (ORIGINAL_API_URL === undefined) delete process.env.RAG_API_URL
  else process.env.RAG_API_URL = ORIGINAL_API_URL
  if (ORIGINAL_SERVICE_TOKEN === undefined) delete process.env.RAG_SERVICE_TOKEN
  else process.env.RAG_SERVICE_TOKEN = ORIGINAL_SERVICE_TOKEN
})

describe('toolsForProvider', () => {
  it('returns undefined for perplexity when RAG is disabled (no tools to wire)', () => {
    const tools = toolsForProvider('perplexity', { userId: 'u1' })
    expect(tools).toBeUndefined()
  })

  it('returns web_search for anthropic when RAG is disabled', () => {
    const tools = toolsForProvider('anthropic', { userId: 'u1' })
    expect(tools).toBeDefined()
    expect(Object.keys(tools!)).toEqual(['web_search'])
  })

  it('returns google_search for google when RAG is disabled', () => {
    const tools = toolsForProvider('google', { userId: 'u1' })
    expect(tools).toBeDefined()
    expect(Object.keys(tools!)).toEqual(['google_search'])
  })

  it('adds rag_search to anthropic + google when RAG is enabled (perplexity skipped)', () => {
    process.env.RAG_API_URL = 'https://rag.example.com'
    process.env.RAG_SERVICE_TOKEN = 'tok'
    // Perplexity stays toolless — @ai-sdk/perplexity strips `tools` from
    // the request body, so registering rag_search here would silently no-op.
    expect(toolsForProvider('perplexity', { userId: 'u1' })).toBeUndefined()
    expect(Object.keys(toolsForProvider('anthropic', { userId: 'u1' })!).sort()).toEqual(['rag_search', 'web_search'])
    expect(Object.keys(toolsForProvider('google', { userId: 'u1' })!).sort()).toEqual(['google_search', 'rag_search'])
  })
})
