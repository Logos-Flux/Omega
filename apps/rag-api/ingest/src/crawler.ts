import { createHash } from 'node:crypto'
import { getPool } from './db'
import { getDriveAccessToken } from './oauth'
import { listAllUserFiles, downloadFile, type DriveFile } from './gdrive'
import { uploadDocument, deleteDocument, parseDocuments } from './ragflow'

interface UserRow {
  id: string
  tenant_id: string
  chat_user_id: string
}

interface DatasetRow {
  id: string
  ragflow_dataset_id: string
}

// Run a per-user Drive crawl. Walks every file the user can see, dedups
// across users by (tenant_id, gdrive_file_id), uploads new/changed
// content to RAGFlow, refreshes the user's user_file_access rows.
//
// Files the user could see last time but can't see now (lost share)
// have their user_file_access row dropped — but the file row itself
// stays in case another user can still see it. Garbage collection of
// orphan files happens in the /forget path, not here.
export async function crawlForUser(jobId: string, userId: string): Promise<{ files_seen: number; files_changed: number }> {
  const pool = getPool()

  const userRes = await pool.query<UserRow>(
    `SELECT id, tenant_id, chat_user_id FROM rag.users WHERE id = $1`,
    [userId],
  )
  const user = userRes.rows[0]
  if (!user) throw new Error(`rag.users id ${userId} not found`)

  const datasetRes = await pool.query<DatasetRow>(
    `SELECT id, ragflow_dataset_id FROM rag.datasets WHERE tenant_id = $1 LIMIT 1`,
    [user.tenant_id],
  )
  const dataset = datasetRes.rows[0]
  if (!dataset) {
    throw new Error('no RAGFlow dataset configured for tenant — create one in the RAGFlow UI first')
  }

  const accessToken = await getDriveAccessToken(user.chat_user_id)
  // RAG_FOLDER_ALLOWLIST is comma-separated Drive folder IDs (or shared-
  // drive IDs). Empty/unset → whole-drive walk. Multi-tenant promotion
  // path: replace this env read with a per-tenant lookup against a
  // rag.tenant_drive_scope table. Same shape, same listAllUserFiles call.
  const allowlist = (process.env.RAG_FOLDER_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const files = await listAllUserFiles(accessToken, allowlist.length > 0 ? allowlist : undefined)

  let filesChanged = 0
  const seenFileIds: string[] = []
  const newDocIds: string[] = []

  for (const file of files) {
    seenFileIds.push(file.id)
    const result = await ingestOne(user.tenant_id, dataset.id, dataset.ragflow_dataset_id, accessToken, file)
    if (result.changed) filesChanged++
    if (result.newDocId) newDocIds.push(result.newDocId)

    await pool.query(
      `INSERT INTO rag.user_file_access (user_id, file_id, last_checked_at)
       SELECT $1, f.id, NOW() FROM rag.files f
        WHERE f.tenant_id = $2 AND f.gdrive_file_id = $3
       ON CONFLICT (user_id, file_id) DO UPDATE SET last_checked_at = NOW()`,
      [user.id, user.tenant_id, file.id],
    )
  }

  // Drop access rows for files this user no longer sees.
  if (seenFileIds.length === 0) {
    await pool.query(`DELETE FROM rag.user_file_access WHERE user_id = $1`, [user.id])
  } else {
    await pool.query(
      `DELETE FROM rag.user_file_access a
        USING rag.files f
        WHERE a.file_id = f.id
          AND a.user_id = $1
          AND NOT (f.gdrive_file_id = ANY($2::text[]))`,
      [user.id, seenFileIds],
    )
  }

  // Kick off RAGFlow parsing for any docs we just uploaded. Without
  // this they sit in 'unparsed' state and don't show up in retrieval.
  if (newDocIds.length > 0) {
    try {
      await parseDocuments(dataset.ragflow_dataset_id, newDocIds)
    } catch (err) {
      console.warn('[crawler] parse trigger failed:', (err as Error).message)
    }
  }

  return { files_seen: files.length, files_changed: filesChanged }
}

async function ingestOne(
  tenantId: string,
  ragDatasetRowId: string,
  ragflowDatasetId: string,
  accessToken: string,
  file: DriveFile,
): Promise<{ changed: boolean; newDocId: string | null }> {
  const pool = getPool()
  const existing = await pool.query<{ id: string; content_hash: string | null; ragflow_doc_id: string | null }>(
    `SELECT id, content_hash, ragflow_doc_id FROM rag.files
      WHERE tenant_id = $1 AND gdrive_file_id = $2`,
    [tenantId, file.id],
  )

  // Download — needed to compute content_hash either way. For native
  // Google docs this exports as docx/xlsx/pptx and the export bytes
  // change deterministically with the doc, so the hash is meaningful.
  const dl = await downloadFile(accessToken, file)
  const hash = createHash('sha256').update(dl.body).digest('hex')

  if (existing.rows.length > 0 && existing.rows[0]!.content_hash === hash) {
    return { changed: false, newDocId: null }
  }

  // New or changed — push to RAGFlow. If the file row already had a
  // ragflow_doc_id we delete the old doc first so we don't accumulate
  // dead documents.
  if (existing.rows.length > 0 && existing.rows[0]!.ragflow_doc_id) {
    try {
      await deleteDocument(ragflowDatasetId, existing.rows[0]!.ragflow_doc_id)
    } catch (err) {
      console.warn('[crawler] delete-old failed:', (err as Error).message)
    }
  }

  const { docId } = await uploadDocument(ragflowDatasetId, dl.filename, dl.body, dl.mimeType)

  await pool.query(
    `INSERT INTO rag.files (tenant_id, dataset_id, gdrive_file_id, content_hash, mime_type, name, ragflow_doc_id, size_bytes, last_indexed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (tenant_id, gdrive_file_id)
       DO UPDATE SET content_hash = EXCLUDED.content_hash,
                     mime_type = EXCLUDED.mime_type,
                     name = EXCLUDED.name,
                     ragflow_doc_id = EXCLUDED.ragflow_doc_id,
                     size_bytes = EXCLUDED.size_bytes,
                     last_indexed_at = NOW()`,
    [
      tenantId,
      ragDatasetRowId,
      file.id,
      hash,
      dl.mimeType,
      file.name,
      docId,
      file.size ? Number(file.size) : null,
    ],
  )

  return { changed: true, newDocId: docId }
}
