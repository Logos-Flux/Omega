// RAGFlow client (worker subset). Mirrors a slice of api/src/lib/ragflow.ts.

// Read env lazily (per call) — top-level consts capture at first
// module-load, which makes tests and per-process env overrides ignore
// re-assignment. Same trap that bit chat-api's WORKSPACE_ROOT in v0.1.0.
function baseUrl(): string {
  return process.env.RAGFLOW_BASE_URL ?? 'http://docker-ragflow-cpu-1:9380'
}

function apiKey(): string {
  const k = process.env.RAGFLOW_API_KEY
  if (!k) throw new Error('RAGFLOW_API_KEY not set')
  return k
}

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

export async function uploadDocument(
  datasetId: string,
  filename: string,
  body: Buffer | Uint8Array,
  mimeType: string,
): Promise<{ docId: string }> {
  const form = new FormData()
  form.append('file', new Blob([body], { type: mimeType }), filename)
  const res = await fetch(`${baseUrl()}/api/v1/datasets/${datasetId}/documents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}` },
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
  const res = await fetch(`${baseUrl()}/api/v1/datasets/${datasetId}/documents`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ids: [docId] }),
  })
  await assertOk(res)
}

// Trigger parsing for a freshly-uploaded doc. Without this RAGFlow
// keeps the doc in 'unparsed' state (run: UNSTART, chunks: 0) and
// retrieval bombs with `KeyError('id')` for queries that try to use it.
export async function parseDocuments(datasetId: string, docIds: string[]): Promise<void> {
  const res = await fetch(`${baseUrl()}/api/v1/datasets/${datasetId}/chunks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ document_ids: docIds }),
  })
  await assertOk(res)
}

// RAGFlow returns `{ code, data, message }` envelopes. A non-zero `code`
// means failure even when the HTTP status is 200 — we hit this with
// `200 { code: 100, data: null, message: "KeyError('id')" }` from
// /chunks when the parse step couldn't find a doc id, and from /documents
// (DELETE) under similar conditions. Treating both layers as errors keeps
// silent envelope failures from looking like crawl success.
async function assertOk(res: Response): Promise<void> {
  const text = await res.text()
  if (!res.ok) throw new RagflowError(res.status, text)
  // Tolerate empty bodies (some RAGFlow responses are 200 with no body).
  if (!text) return
  let env: RagflowEnvelope<unknown>
  try {
    env = JSON.parse(text) as RagflowEnvelope<unknown>
  } catch {
    // Non-JSON 200 — assume success.
    return
  }
  if (typeof env.code === 'number' && env.code !== 0) {
    throw new RagflowError(res.status, text)
  }
}
