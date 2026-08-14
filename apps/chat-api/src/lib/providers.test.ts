/**
 * Tests for toolsForProvider. The interesting cases are:
 *   - rag_search appears iff RAG env is set (mirrors the harness)
 *   - web_search / google_search are still wired per-provider
 *   - returns undefined when nothing is wired (so the AI SDK doesn't
 *     emit an empty `tools: {}` that some providers reject)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { toolsForProvider } from './providers'

const ORIGINAL_API_URL = process.env.RAG_API_URL
const ORIGINAL_SERVICE_TOKEN = process.env.RAG_SERVICE_TOKEN
const ORIGINAL_FILE_SEARCH = process.env.GEMINI_FILE_SEARCH_STORE

beforeEach(() => {
  delete process.env.RAG_API_URL
  delete process.env.RAG_SERVICE_TOKEN
  delete process.env.GEMINI_FILE_SEARCH_STORE
})

afterEach(() => {
  if (ORIGINAL_API_URL === undefined) delete process.env.RAG_API_URL
  else process.env.RAG_API_URL = ORIGINAL_API_URL
  if (ORIGINAL_SERVICE_TOKEN === undefined) delete process.env.RAG_SERVICE_TOKEN
  else process.env.RAG_SERVICE_TOKEN = ORIGINAL_SERVICE_TOKEN
  if (ORIGINAL_FILE_SEARCH === undefined) delete process.env.GEMINI_FILE_SEARCH_STORE
  else process.env.GEMINI_FILE_SEARCH_STORE = ORIGINAL_FILE_SEARCH
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

  it('adds rag_search to every provider when RAG is enabled', () => {
    process.env.RAG_API_URL = 'https://rag.example.com'
    process.env.RAG_SERVICE_TOKEN = 'tok'
    expect(Object.keys(toolsForProvider('perplexity', { userId: 'u1' })!).sort()).toEqual(['rag_search'])
    expect(Object.keys(toolsForProvider('anthropic', { userId: 'u1' })!).sort()).toEqual(['rag_search', 'web_search'])
    expect(Object.keys(toolsForProvider('google', { userId: 'u1' })!).sort()).toEqual(['google_search', 'rag_search'])
  })

  describe('Gemini File Search', () => {
    beforeEach(() => {
      process.env.GEMINI_FILE_SEARCH_STORE = 'fileSearchStores/test-store'
    })

    it('swaps google_search for file_search on the google provider', () => {
      expect(Object.keys(toolsForProvider('google', { userId: 'u1' })!)).toEqual(['file_search'])
    })

    it('uses file_search instead of rag_search on google even when RAG is enabled', () => {
      process.env.RAG_API_URL = 'https://rag.example.com'
      process.env.RAG_SERVICE_TOKEN = 'tok'
      // Gemini path retrieves via File Search; RAGFlow is dropped here so the
      // A/B stays clean (Anthropic keeps rag_search).
      expect(Object.keys(toolsForProvider('google', { userId: 'u1' })!)).toEqual(['file_search'])
      expect(Object.keys(toolsForProvider('anthropic', { userId: 'u1' })!).sort()).toEqual([
        'rag_search',
        'web_search',
      ])
    })

    it('does not affect non-google providers', () => {
      expect(Object.keys(toolsForProvider('anthropic', { userId: 'u1' })!)).toEqual(['web_search'])
      expect(toolsForProvider('perplexity', { userId: 'u1' })).toBeUndefined()
    })
  })
})
