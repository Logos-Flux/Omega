// RAGFlow REST client. RAGFlow exposes its HTTP API on :9380. Auth is a
// long-lived API key issued in the RAGFlow admin UI. We use a single
// service-level key (rag-api speaks to RAGFlow as one user) and rely on
// the document_ids retrieval filter to enforce per-user ACLs.
//
// Upstream API reference (lives on the LXC):
//   /opt/ragflow/docs/references/http_api_reference.md
// The shape below tracks RAGFlow v0.25.x.

const BASE_URL = process.env.RAGFLOW_BASE_URL ?? 'http://docker-ragflow-cpu-1:9380'
const API_KEY = process.env.RAGFLOW_API_KEY ?? ''

export class RagflowError extends Error {
  constructor(public status: number, public bodyText: string) {
    super(`ragflow ${status}: ${bodyText.slice(0, 500)}`)
  }
}

interface RagflowEnvelope<T> {
  code: number
  data?: T
  message?: string
}

async function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_KEY) throw new Error('RAGFLOW_API_KEY not set')
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new RagflowError(res.status, text)
  const env = JSON.parse(text) as RagflowEnvelope<T>
  if (env.code !== 0) throw new RagflowError(res.status, text)
  return env.data as T
}

export interface RagflowDataset {
  id: string
  name: string
  embedding_model?: string
  document_count?: number
}

export async function listDatasets(): Promise<RagflowDataset[]> {
  return jsonRequest<RagflowDataset[]>('/api/v1/datasets?page_size=100')
}

export async function createDataset(name: string, embeddingModel: string): Promise<RagflowDataset> {
  return jsonRequest<RagflowDataset>('/api/v1/datasets', {
    method: 'POST',
    body: JSON.stringify({ name, embedding_model: embeddingModel }),
  })
}

// Upload a file as a new RAGFlow document. RAGFlow chunks + embeds
// asynchronously after upload — the returned doc id is usable in
// retrieval immediately, but chunks may not appear for a few seconds.
export async function uploadDocument(
  datasetId: string,
  filename: string,
  body: Buffer | Uint8Array,
  mimeType?: string,
): Promise<{ docId: string }> {
  if (!API_KEY) throw new Error('RAGFLOW_API_KEY not set')
  const form = new FormData()
  // RAGFlow expects multipart with field name 'file'.
  const blob = new Blob([body], mimeType ? { type: mimeType } : undefined)
  form.append('file', blob, filename)

  const res = await fetch(`${BASE_URL}/api/v1/datasets/${datasetId}/documents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: form,
  })
  const text = await res.text()
  if (!res.ok) throw new RagflowError(res.status, text)
  const env = JSON.parse(text) as RagflowEnvelope<Array<{ id: string }>>
  if (env.code !== 0) throw new RagflowError(res.status, text)
  const created = env.data?.[0]
  if (!created?.id) throw new RagflowError(res.status, `unexpected upload response: ${text}`)
  return { docId: created.id }
}

export async function deleteDocument(datasetId: string, docId: string): Promise<void> {
  await jsonRequest<unknown>(`/api/v1/datasets/${datasetId}/documents`, {
    method: 'DELETE',
    body: JSON.stringify({ ids: [docId] }),
  })
}

export interface RetrievalChunk {
  id: string
  content: string
  document_id: string
  document_keyword?: string
  similarity?: number
  vector_similarity?: number
  term_similarity?: number
  highlight?: string
}

interface RetrievalResponse {
  chunks: RetrievalChunk[]
  doc_aggs?: Array<{ doc_id: string; doc_name: string; count: number }>
  total: number
}

// Run vector + keyword retrieval, optionally scoped to a list of
// document ids. The document_ids filter is what carries the per-user
// ACL into vector search — see RAG-HANDOFF.md §"ACL model".
export async function retrieve(args: {
  question: string
  datasetIds: string[]
  documentIds?: string[]
  topK?: number
  similarityThreshold?: number
  highlight?: boolean
}): Promise<RetrievalResponse> {
  const body: Record<string, unknown> = {
    question: args.question,
    dataset_ids: args.datasetIds,
  }
  if (args.documentIds && args.documentIds.length > 0) body.document_ids = args.documentIds
  if (args.topK != null) body.top_k = args.topK
  if (args.similarityThreshold != null) body.similarity_threshold = args.similarityThreshold
  if (args.highlight) body.highlight = true

  return jsonRequest<RetrievalResponse>('/api/v1/retrieval', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
