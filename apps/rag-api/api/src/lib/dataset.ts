import { getPool } from './db'
import { listDatasets } from './ragflow'

// Resolve the (one) RAGFlow dataset this tenant uses. If we already
// have a row in rag.datasets, return it. Otherwise look at RAGFlow:
//
//  - exactly one dataset present → adopt it
//  - none present → return null (caller surfaces a setup error)
//  - several present → require RAGFLOW_DATASET_ID to disambiguate
//
// One-time bootstrap. After the first call the row is cached in our
// own DB and we stop probing RAGFlow.
export interface Dataset {
  id: string // rag.datasets.id
  ragflow_dataset_id: string
  embedding_model: string
}

export async function resolveTenantDataset(tenantId: string): Promise<Dataset | null> {
  const pool = getPool()
  const existing = await pool.query<Dataset>(
    `SELECT id, ragflow_dataset_id, embedding_model
       FROM rag.datasets
      WHERE tenant_id = $1
      LIMIT 1`,
    [tenantId],
  )
  if (existing.rows.length > 0) return existing.rows[0]!

  let datasets
  try {
    datasets = await listDatasets()
  } catch (err) {
    console.warn('[dataset] could not list RAGFlow datasets:', (err as Error).message)
    return null
  }
  if (!datasets || datasets.length === 0) return null

  const preferredId = process.env.RAGFLOW_DATASET_ID ?? ''
  let pick = datasets.length === 1 ? datasets[0] : datasets.find((d) => d.id === preferredId)
  if (!pick) {
    console.warn(
      `[dataset] ${datasets.length} RAGFlow datasets found; set RAGFLOW_DATASET_ID to one of: ${datasets
        .map((d) => d.id)
        .join(', ')}`,
    )
    return null
  }

  const inserted = await pool.query<Dataset>(
    `INSERT INTO rag.datasets (tenant_id, ragflow_dataset_id, name, embedding_model)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ragflow_dataset_id) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, ragflow_dataset_id, embedding_model`,
    [tenantId, pick.id, pick.name, pick.embedding_model ?? 'unknown'],
  )
  return inserted.rows[0]!
}
