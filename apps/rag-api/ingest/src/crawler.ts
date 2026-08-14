import { createHash } from 'node:crypto'
import { getPool } from './db'
import { pickSource, type RagSource, type SourceFile, type SourceUser } from './source'
import { uploadDocument, deleteDocument, parseDocuments } from './ragflow'

interface UserRow {
  id: string
  tenant_id: string
  chat_user_id: string
  gdrive_my_ai_folder_id: string | null
  gdrive_my_ai_status: 'unknown' | 'present' | 'missing'
}

interface DatasetRow {
  id: string
  ragflow_dataset_id: string
}

// Run a per-user crawl. Walks every file the active source surfaces for
// the user, dedups across users by (tenant_id, source_kind, source_id),
// uploads new/changed content to RAGFlow, refreshes the user's
// user_file_access rows.
//
// Files the user could see last time but can't see now (lost share, file
// deleted from disk) have their user_file_access row dropped — but the
// file row itself stays in case another user can still see it. Garbage
// collection of orphan files happens in the /forget path, not here.
//
// The crawler is source-agnostic: drive vs filesystem is picked once via
// RAG_SOURCE in source.ts. Cross-source bookkeeping (e.g. dropping
// filesystem-only access rows when running a drive crawl) is scoped by
// `source.kind` so a single-source crawl only manages its own rows.
export async function crawlForUser(jobId: string, userId: string): Promise<{ files_seen: number; files_changed: number; files_failed: number }> {
  const pool = getPool()

  const userRes = await pool.query<UserRow>(
    `SELECT id, tenant_id, chat_user_id, gdrive_my_ai_folder_id, gdrive_my_ai_status
       FROM rag.users WHERE id = $1`,
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

  const source = await pickSource()
  const sourceUser: SourceUser = user
  const files = await source.listForUser(sourceUser)

  let filesChanged = 0
  let filesFailed = 0
  const seenSourceIds: string[] = []
  const newDocIds: string[] = []

  // BUG-09 — heartbeat lease. Bump sync_jobs.heartbeat_at periodically so the
  // reaper (which compares COALESCE(heartbeat_at, started_at) to the timeout)
  // never falsely reaps a genuinely-long-but-alive crawl. Stamp one up front
  // so a slow first file doesn't start the clock at started_at.
  let sinceHeartbeat = 0
  const HEARTBEAT_EVERY = 10
  const beat = () =>
    pool.query(`UPDATE rag.sync_jobs SET heartbeat_at = NOW() WHERE id = $1`, [jobId])
  await beat()

  for (const file of files) {
    // Per-file failures (transient I/O 5xx, RAGFlow upload rejection,
    // export size limit, etc.) are isolated — log and continue. Killing
    // the whole crawl on one bad file used to be the dominant failure
    // mode (issue #4). The user_file_access INSERT below is a no-op
    // when the rag.files row doesn't exist yet, so a never-ingested
    // file just stays uncatalogued without blocking the rest of the run.
    seenSourceIds.push(file.id)
    try {
      const result = await ingestOne(
        user.tenant_id,
        dataset.id,
        dataset.ragflow_dataset_id,
        source,
        sourceUser,
        file,
      )
      if (result.changed) filesChanged++
      if (result.newDocId) newDocIds.push(result.newDocId)
    } catch (err) {
      filesFailed++
      console.warn(
        `[crawler] ingest failed for ${file.source}:${file.id} (${file.mimeType}) "${file.name}":`,
        (err as Error).message,
      )
    }

    await pool.query(
      `INSERT INTO rag.user_file_access (user_id, file_id, last_checked_at)
       SELECT $1, f.id, NOW() FROM rag.files f
        WHERE f.tenant_id = $2 AND f.source_kind = $3 AND f.source_id = $4
       ON CONFLICT (user_id, file_id) DO UPDATE SET last_checked_at = NOW()`,
      [user.id, user.tenant_id, source.kind, file.id],
    )

    if (++sinceHeartbeat >= HEARTBEAT_EVERY) {
      sinceHeartbeat = 0
      await beat()
    }
  }
  if (filesFailed > 0) {
    console.warn(`[crawler] ${filesFailed}/${files.length} files failed for user ${user.chat_user_id}`)
  }

  // Drop access rows for files this user no longer sees, scoped to the
  // current source's kind. A `drive`-mode crawl never touches filesystem
  // access rows and vice versa — useful during a `RAG_SOURCE` migration
  // window where one source is being drained while the other ramps up.
  if (seenSourceIds.length === 0) {
    await pool.query(
      `DELETE FROM rag.user_file_access a
        USING rag.files f
        WHERE a.file_id = f.id
          AND a.user_id = $1
          AND f.source_kind = $2`,
      [user.id, source.kind],
    )
  } else {
    await pool.query(
      `DELETE FROM rag.user_file_access a
        USING rag.files f
        WHERE a.file_id = f.id
          AND a.user_id = $1
          AND f.source_kind = $2
          AND NOT (f.source_id = ANY($3::text[]))`,
      [user.id, source.kind, seenSourceIds],
    )
  }

  // Kick off RAGFlow parsing for any docs we just uploaded. Without
  // this they sit in 'UNSTART' state and `/api/v1/query` 500s with
  // `KeyError('id')` for any query that touches them. A parse failure
  // here propagates: the worker (index.ts processOne) catches and marks
  // the job `failed` with the error in `rag.users.last_error`, so the
  // chat-side status UI surfaces it instead of pretending the crawl
  // succeeded. Silent-swallow was the bug we're fixing.
  if (newDocIds.length > 0) {
    await parseDocuments(dataset.ragflow_dataset_id, newDocIds)
  }

  return { files_seen: files.length, files_changed: filesChanged, files_failed: filesFailed }
}

async function ingestOne(
  tenantId: string,
  ragDatasetRowId: string,
  ragflowDatasetId: string,
  source: RagSource,
  user: SourceUser,
  file: SourceFile,
): Promise<{ changed: boolean; newDocId: string | null }> {
  const pool = getPool()
  const existing = await pool.query<{ id: string; content_hash: string | null; ragflow_doc_id: string | null }>(
    `SELECT id, content_hash, ragflow_doc_id FROM rag.files
      WHERE tenant_id = $1 AND source_kind = $2 AND source_id = $3`,
    [tenantId, file.source, file.id],
  )

  // Download — needed to compute content_hash either way. For native
  // Google docs this exports as docx/xlsx/pptx and the export bytes
  // change deterministically with the doc, so the hash is meaningful.
  // For filesystem files this just reads the bytes.
  const dl = await source.download(file, user)
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

  // gdrive_file_id stays populated for drive-source rows so existing
  // queries that read it keep working; filesystem rows leave it NULL.
  // The unique key the table enforces is (tenant_id, source_kind,
  // source_id), added in migration 0004.
  const gdriveFileId = file.source === 'drive' ? file.id : null

  await pool.query(
    `INSERT INTO rag.files (tenant_id, dataset_id, source_kind, source_id, gdrive_file_id, content_hash, mime_type, name, ragflow_doc_id, size_bytes, last_indexed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (tenant_id, source_kind, source_id)
       DO UPDATE SET content_hash = EXCLUDED.content_hash,
                     mime_type = EXCLUDED.mime_type,
                     name = EXCLUDED.name,
                     ragflow_doc_id = EXCLUDED.ragflow_doc_id,
                     size_bytes = EXCLUDED.size_bytes,
                     last_indexed_at = NOW()`,
    [
      tenantId,
      ragDatasetRowId,
      file.source,
      file.id,
      gdriveFileId,
      hash,
      dl.mimeType,
      file.name,
      docId,
      file.size ? Number(file.size) : null,
    ],
  )

  return { changed: true, newDocId: docId }
}
