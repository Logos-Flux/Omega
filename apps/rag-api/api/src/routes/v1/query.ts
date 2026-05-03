import { Hono } from 'hono'
import { getPool } from '../../lib/db'
import { resolveTenantDataset } from '../../lib/dataset'
import { resolveUser } from '../../lib/users'
import { retrieve, type RetrievalChunk } from '../../lib/ragflow'

export const queryRoutes = new Hono()

interface QueryBody {
  user_id?: string
  query?: string
  top_k?: number
  scope?: { folder_ids?: string[] }
}

interface OutChunk {
  file_id: string
  file_name: string
  snippet: string
  score: number
  chunk_id: string
  source_url: string | null
}

queryRoutes.post('/', async (c) => {
  const tenant = c.get('tenant')
  const body = (await c.req.json().catch(() => ({}))) as QueryBody

  if (!body.user_id) return c.json({ error: 'user_id required' }, 400)
  if (!body.query) return c.json({ error: 'query required' }, 400)

  const user = await resolveUser(tenant.id, body.user_id)
  const dataset = await resolveTenantDataset(tenant.id)
  if (!dataset) {
    return c.json({ error: 'no RAGFlow dataset configured for tenant; create one in the RAGFlow UI' }, 503)
  }

  // Pull this user's allowed RAGFlow document ids. scope.folder_ids is
  // accepted in the contract but not yet wired — folder metadata isn't
  // tracked in v1's schema. Empty result short-circuits to [].
  const accessRows = await getPool().query<{ ragflow_doc_id: string | null; gdrive_file_id: string; name: string | null }>(
    `SELECT f.ragflow_doc_id, f.gdrive_file_id, f.name
       FROM rag.user_file_access a
       JOIN rag.files f ON f.id = a.file_id
      WHERE a.user_id = $1
        AND f.dataset_id = $2
        AND f.ragflow_doc_id IS NOT NULL`,
    [user.id, dataset.id],
  )

  if (accessRows.rows.length === 0) {
    return c.json({ chunks: [] satisfies OutChunk[] })
  }

  const docIdToFile = new Map(
    accessRows.rows
      .filter((r) => r.ragflow_doc_id)
      .map((r) => [r.ragflow_doc_id!, { gdrive_file_id: r.gdrive_file_id, name: r.name }]),
  )

  const result = await retrieve({
    question: body.query,
    datasetIds: [dataset.ragflow_dataset_id],
    documentIds: Array.from(docIdToFile.keys()),
    topK: body.top_k ?? 8,
  })

  getPool()
    .query(
      `INSERT INTO rag.audit (tenant_id, action, payload) VALUES ($1, 'query', $2)`,
      [tenant.id, JSON.stringify({ user_id: body.user_id, top_k: body.top_k ?? 8, found: result.chunks?.length ?? 0 })],
    )
    .catch((err) => console.warn('[query] audit write failed:', (err as Error).message))

  const chunks: OutChunk[] = (result.chunks ?? []).map((rc: RetrievalChunk) => {
    const meta = docIdToFile.get(rc.document_id)
    return {
      file_id: meta?.gdrive_file_id ?? rc.document_id,
      file_name: meta?.name ?? rc.document_keyword ?? '',
      snippet: rc.highlight ?? rc.content ?? '',
      score: rc.similarity ?? rc.vector_similarity ?? 0,
      chunk_id: rc.id,
      source_url: meta?.gdrive_file_id ? `https://drive.google.com/file/d/${meta.gdrive_file_id}/view` : null,
    }
  })

  return c.json({ chunks })
})
