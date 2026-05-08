/**
 * Verifies that the RAGFlow client throws on every documented failure
 * shape — particularly `200 OK { code: 100, message: "KeyError('id')" }`,
 * which used to be silently swallowed and let the crawler return
 * success even though the docs sat at `UNSTART` forever.
 *
 * Run with: bun test apps/rag-api/ingest/src/ragflow.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { deleteDocument, parseDocuments, RagflowError, uploadDocument } from './ragflow'

const originalFetch = globalThis.fetch

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

function stubFetch(response: Response): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: typeof url === 'string' ? url : url.toString(), init })
    return response
  }) as typeof globalThis.fetch
  return calls
}

beforeEach(() => {
  process.env.RAGFLOW_BASE_URL = 'http://test-ragflow:9380'
  process.env.RAGFLOW_API_KEY = 'test-api-key'
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('parseDocuments', () => {
  it('succeeds on 200 with code 0', async () => {
    const calls = stubFetch(new Response(JSON.stringify({ code: 0, data: true }), { status: 200 }))
    await parseDocuments('ds-1', ['doc-1', 'doc-2'])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://test-ragflow:9380/api/v1/datasets/ds-1/chunks')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ document_ids: ['doc-1', 'doc-2'] })
  })

  it('throws RagflowError on HTTP 500', async () => {
    stubFetch(new Response('upstream blew up', { status: 500 }))
    await expect(parseDocuments('ds-1', ['doc-1'])).rejects.toBeInstanceOf(RagflowError)
  })

  // The regression we're fixing. RAGFlow returns 200 OK with a non-zero
  // envelope code when the parse couldn't find one of the document ids
  // (`KeyError('id')`). Previously this was silently swallowed and the
  // crawler reported success even though chunks were never created.
  it('throws RagflowError on 200 with non-zero envelope code', async () => {
    stubFetch(
      new Response(
        JSON.stringify({ code: 100, data: null, message: "KeyError('id')" }),
        { status: 200 },
      ),
    )
    await expect(parseDocuments('ds-1', ['doc-1'])).rejects.toBeInstanceOf(RagflowError)
  })

  it('tolerates empty 200 body', async () => {
    stubFetch(new Response('', { status: 200 }))
    await expect(parseDocuments('ds-1', ['doc-1'])).resolves.toBeUndefined()
  })

  it('tolerates non-JSON 200 body (treats as success)', async () => {
    stubFetch(new Response('OK', { status: 200 }))
    await expect(parseDocuments('ds-1', ['doc-1'])).resolves.toBeUndefined()
  })
})

describe('deleteDocument', () => {
  it('succeeds on 200 with code 0', async () => {
    const calls = stubFetch(new Response(JSON.stringify({ code: 0 }), { status: 200 }))
    await deleteDocument('ds-1', 'doc-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init?.method).toBe('DELETE')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ ids: ['doc-1'] })
  })

  it('throws on 200 with non-zero envelope code', async () => {
    stubFetch(new Response(JSON.stringify({ code: 102, message: 'no such doc' }), { status: 200 }))
    await expect(deleteDocument('ds-1', 'doc-1')).rejects.toBeInstanceOf(RagflowError)
  })

  it('throws on HTTP 500', async () => {
    stubFetch(new Response('boom', { status: 500 }))
    await expect(deleteDocument('ds-1', 'doc-1')).rejects.toBeInstanceOf(RagflowError)
  })
})

describe('uploadDocument', () => {
  it('returns the docId from a successful upload', async () => {
    stubFetch(
      new Response(JSON.stringify({ code: 0, data: [{ id: 'new-doc-id' }] }), { status: 200 }),
    )
    const result = await uploadDocument('ds-1', 'foo.csv', Buffer.from('a,b,c'), 'text/csv')
    expect(result).toEqual({ docId: 'new-doc-id' })
  })

  it('throws on 200 with non-zero envelope code', async () => {
    stubFetch(
      new Response(JSON.stringify({ code: 100, message: 'duplicate filename' }), { status: 200 }),
    )
    await expect(uploadDocument('ds-1', 'foo.csv', Buffer.from('x'), 'text/csv')).rejects.toBeInstanceOf(RagflowError)
  })

  it('throws when API key is missing', async () => {
    delete process.env.RAGFLOW_API_KEY
    await expect(uploadDocument('ds-1', 'foo.csv', Buffer.from('x'), 'text/csv')).rejects.toThrow(/RAGFLOW_API_KEY/)
  })
})
