// RAGFlow client (worker subset). Mirrors a slice of api/src/lib/ragflow.ts.

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

export async function uploadDocument(
  datasetId: string,
  filename: string,
  body: Buffer | Uint8Array,
  mimeType: string,
): Promise<{ docId: string }> {
  if (!API_KEY) throw new Error('RAGFLOW_API_KEY not set')
  const form = new FormData()
  form.append('file', new Blob([body], { type: mimeType }), filename)
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
  const res = await fetch(`${BASE_URL}/api/v1/datasets/${datasetId}/documents`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ids: [docId] }),
  })
  if (!res.ok) throw new RagflowError(res.status, await res.text())
}

// Trigger parsing for a freshly-uploaded doc. Without this RAGFlow
// keeps the doc in 'unparsed' state and chunks never appear, so
// retrieval returns nothing for it.
export async function parseDocuments(datasetId: string, docIds: string[]): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/datasets/${datasetId}/chunks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ document_ids: docIds }),
  })
  if (!res.ok) throw new RagflowError(res.status, await res.text())
}
