/**
 * Tests for chat-api's rag-api client. Mirrors the four cases the AI SDK
 * tool wrapper has to handle: disabled config, network failure, HTTP
 * error, and a happy path with chunks. The client returns `{ error:
 * string }` rather than throwing so the tool wrapper can surface the
 * message to the model instead of bailing the whole turn.
 *
 * Kept structurally identical to apps/pi-harness/test/rag.test.ts —
 * the two services intentionally share a contract with rag-api.
 *
 * Run with: bun test apps/chat-api/src/lib/rag.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { _resetWarnLatchForTests, getRagConfig, isRagEnabled, searchRag } from './rag'

const ORIGINAL_API_URL = process.env.RAG_API_URL
const ORIGINAL_SERVICE_TOKEN = process.env.RAG_SERVICE_TOKEN
const ORIGINAL_FETCH = globalThis.fetch

interface Call {
  url: string
  init: RequestInit | undefined
}

function stubFetch(response: Response | Error): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: typeof url === 'string' ? url : url.toString(), init })
    if (response instanceof Error) throw response
    return response
  }) as typeof globalThis.fetch
  return calls
}

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
  globalThis.fetch = ORIGINAL_FETCH
})

describe('getRagConfig / isRagEnabled', () => {
  it('returns null when both vars unset (RAG disabled)', () => {
    expect(getRagConfig()).toBeNull()
    expect(isRagEnabled()).toBe(false)
  })

  it('returns the config when both vars set', () => {
    process.env.RAG_API_URL = 'https://rag.example.com'
    process.env.RAG_SERVICE_TOKEN = 'tok-123'
    expect(getRagConfig()).toEqual({ apiUrl: 'https://rag.example.com', serviceToken: 'tok-123' })
    expect(isRagEnabled()).toBe(true)
  })

  it('strips trailing slash from RAG_API_URL', () => {
    process.env.RAG_API_URL = 'https://rag.example.com/'
    process.env.RAG_SERVICE_TOKEN = 'tok-123'
    expect(getRagConfig()?.apiUrl).toBe('https://rag.example.com')
  })

  it('returns null when only one of the pair is set', () => {
    process.env.RAG_API_URL = 'https://rag.example.com'
    expect(getRagConfig()).toBeNull()
  })
})

describe('searchRag', () => {
  beforeEach(() => {
    process.env.RAG_API_URL = 'https://rag.example.com'
    process.env.RAG_SERVICE_TOKEN = 'tok-abc'
  })

  it('returns chunks on a successful response', async () => {
    const calls = stubFetch(
      new Response(
        JSON.stringify({
          chunks: [
            {
              file_id: 'f1',
              file_name: 'plan.docx',
              snippet: 'launch in Q3',
              score: 0.42,
              chunk_id: 'c1',
              source_url: 'https://drive.google.com/...',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const result = await searchRag({ userId: 'user-1', query: 'when is launch', topK: 5 })
    expect(result).toEqual({
      chunks: [
        {
          file_id: 'f1',
          file_name: 'plan.docx',
          snippet: 'launch in Q3',
          score: 0.42,
          chunk_id: 'c1',
          source_url: 'https://drive.google.com/...',
        },
      ],
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://rag.example.com/api/v1/query')
    expect(calls[0]!.init?.method).toBe('POST')
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-abc')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      user_id: 'user-1',
      query: 'when is launch',
      top_k: 5,
    })
  })

  it('omits top_k from the body when not provided', async () => {
    const calls = stubFetch(new Response(JSON.stringify({ chunks: [] }), { status: 200 }))
    await searchRag({ userId: 'user-1', query: 'q' })
    const body = JSON.parse(calls[0]!.init!.body as string) as { top_k?: number }
    expect(body.top_k).toBeUndefined()
  })

  it('returns { error } when config is missing — does not call fetch', async () => {
    delete process.env.RAG_API_URL
    delete process.env.RAG_SERVICE_TOKEN
    const calls = stubFetch(new Response('should not be called', { status: 200 }))
    const result = await searchRag({ userId: 'user-1', query: 'q' })
    expect(result).toEqual({ error: 'rag is not configured' })
    expect(calls).toHaveLength(0)
  })

  it('returns { error } on HTTP failure (rag-api 500)', async () => {
    stubFetch(new Response('boom', { status: 500 }))
    const result = await searchRag({ userId: 'user-1', query: 'q' })
    expect(result).toMatchObject({ error: expect.stringContaining('500') })
  })

  it('returns { error } on network failure', async () => {
    stubFetch(new Error('ECONNREFUSED'))
    const result = await searchRag({ userId: 'user-1', query: 'q' })
    expect(result).toMatchObject({ error: expect.stringContaining('unreachable') })
  })

  it('returns { error } on malformed response body', async () => {
    stubFetch(new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 }))
    const result = await searchRag({ userId: 'user-1', query: 'q' })
    expect(result).toMatchObject({ error: expect.stringContaining('malformed') })
  })
})
