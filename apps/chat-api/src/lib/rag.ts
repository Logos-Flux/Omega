// rag.ts — client for the rag-api wrapper service.
//
// Plumbing for the `rag_search` tool exposed in chat-api's tool set
// (providers.ts::toolsForProvider). Only registered when both
// RAG_API_URL and RAG_SERVICE_TOKEN are set, so OSS deployments without
// a RAG backend don't see a non-functional retrieval tool in the LLM's
// tool list.
//
// Mirrors apps/pi-harness/src/lib/rag.ts byte-for-byte except for the
// dropped comment about WORKSPACE_ROOT (not applicable here) — the two
// services intentionally call the same /api/v1/query endpoint with the
// same body shape so a single rag-api change propagates to both
// consumers.
//
// Lazy env reads — top-level consts capture at first module-load and
// can't be overridden per-test or per-process.

export interface RagConfig {
  apiUrl: string
  serviceToken: string
}

export interface RagChunk {
  file_id: string
  file_name: string
  snippet: string
  score: number
  chunk_id: string
  source_url?: string
}

interface QueryResponse {
  chunks: RagChunk[]
}

let warned = false

export function getRagConfig(): RagConfig | null {
  const apiUrl = process.env.RAG_API_URL?.trim()
  const serviceToken = process.env.RAG_SERVICE_TOKEN?.trim()
  if (!apiUrl && !serviceToken) return null
  if (!apiUrl || !serviceToken) {
    if (!warned) {
      console.warn(
        '[rag] one of RAG_API_URL / RAG_SERVICE_TOKEN is set without the other — rag_search disabled',
      )
      warned = true
    }
    return null
  }
  return { apiUrl: apiUrl.replace(/\/$/, ''), serviceToken }
}

export function isRagEnabled(): boolean {
  return getRagConfig() !== null
}

export interface SearchArgs {
  userId: string
  query: string
  topK?: number
}

export interface SearchResult {
  chunks: RagChunk[]
}

// POST {RAG_API_URL}/api/v1/query. The user_id goes in the body — RAG
// never trusts an inbound user identity asserted any other way; it
// resolves the bearer to a tenant and uses the body's user_id to apply
// the per-user ACL filter.
//
// Failures are returned as { error: string } rather than thrown so the
// AI SDK tool wrapper can surface a useful message to the model
// instead of bailing the whole turn.
export async function searchRag(
  args: SearchArgs,
): Promise<SearchResult | { error: string }> {
  const cfg = getRagConfig()
  if (!cfg) return { error: 'rag is not configured' }
  let res: Response
  try {
    res = await fetch(`${cfg.apiUrl}/api/v1/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.serviceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: args.userId,
        query: args.query,
        top_k: args.topK,
      }),
    })
  } catch (err) {
    return { error: `rag-api unreachable: ${(err as Error).message}` }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { error: `rag-api ${res.status}: ${text.slice(0, 200)}` }
  }
  const body = (await res.json().catch(() => null)) as QueryResponse | null
  if (!body || !Array.isArray(body.chunks)) {
    return { error: 'rag-api returned a malformed response' }
  }
  return { chunks: body.chunks }
}

// Test-only: clear the one-shot warning latch. NOT exported via a
// barrel; only callable from a sibling test file.
export function _resetWarnLatchForTests(): void {
  warned = false
}
