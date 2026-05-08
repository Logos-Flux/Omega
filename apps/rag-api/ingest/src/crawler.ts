import { createHash } from 'node:crypto'
import { getPool } from './db'
import { getDriveAccessToken } from './oauth'
import { listAllUserFiles, downloadFile, findFolderByName, type DriveFile } from './gdrive'
import { uploadDocument, deleteDocument, parseDocuments } from './ragflow'

interface UserRow {
  id: string
  tenant_id: string
  chat_user_id: string
  gdrive_my_ai_folder_id: string | null
  gdrive_my_ai_status: 'unknown' | 'present' | 'missing'
}

// Read crawl-scope env lazily — eager top-level consts capture at first
// module-load and tests / per-process overrides can't change them.
function personalFolderName(): string {
  return process.env.RAG_PERSONAL_FOLDER_NAME ?? 'my-ai'
}
function knowledgeBaseFolderId(): string | null {
  return process.env.RAG_KNOWLEDGE_BASE_FOLDER_ID || null
}
function legacyAllowlist(): string[] {
  return (process.env.RAG_FOLDER_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// Resolve and cache the user's personal folder id. Idempotent — if the
// row already has a present id we return it without hitting Drive. On
// 'missing', we don't re-resolve until the chat side bumps status back
// to 'unknown' (e.g. via a "I created the folder, please retry" UI).
async function resolveMyAiFolder(
  user: UserRow,
  accessToken: string,
): Promise<string | null> {
  if (user.gdrive_my_ai_status === 'present' && user.gdrive_my_ai_folder_id) {
    return user.gdrive_my_ai_folder_id
  }
  if (user.gdrive_my_ai_status === 'missing') {
    return null
  }
  const pool = getPool()
  const name = personalFolderName()
  const found = await findFolderByName(accessToken, name)
  if (!found) {
    await pool.query(
      `UPDATE rag.users
          SET gdrive_my_ai_folder_id = NULL,
              gdrive_my_ai_status = 'missing'
        WHERE id = $1`,
      [user.id],
    )
    return null
  }
  if (found.ambiguous) {
    console.warn(
      `[crawler] multiple "${name}" folders for user ${user.chat_user_id}; using oldest (${found.id})`,
    )
  }
  await pool.query(
    `UPDATE rag.users
        SET gdrive_my_ai_folder_id = $2,
            gdrive_my_ai_status = 'present'
      WHERE id = $1`,
    [user.id, found.id],
  )
  return found.id
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

  const accessToken = await getDriveAccessToken(user.chat_user_id)

  // Compose crawl roots from up to three sources, in priority order:
  //   1. The user's personal folder (default name `my-ai`, configurable
  //      via RAG_PERSONAL_FOLDER_NAME). Resolved once and cached on
  //      rag.users.gdrive_my_ai_folder_id.
  //   2. The shared knowledge-base folder (RAG_KNOWLEDGE_BASE_FOLDER_ID),
  //      identical for every user; per-user OAuth permissions filter
  //      what each user actually sees inside it.
  //   3. Legacy RAG_FOLDER_ALLOWLIST. Deprecated — log a warning and
  //      remove next release. Kept as a one-release fallback so
  //      operators don't lose ingest while they migrate config.
  const roots: string[] = []
  const myAiId = await resolveMyAiFolder(user, accessToken)
  if (myAiId) roots.push(myAiId)
  const kbId = knowledgeBaseFolderId()
  if (kbId) roots.push(kbId)
  const legacy = legacyAllowlist()
  if (legacy.length > 0) {
    console.warn(
      '[crawler] RAG_FOLDER_ALLOWLIST is deprecated; switch to RAG_KNOWLEDGE_BASE_FOLDER_ID + per-user `my-ai` folders. ' +
        'This env will be removed in the next release.',
    )
    roots.push(...legacy)
  }

  // Refuse to whole-Drive walk. Earlier behaviour (empty allowlist →
  // full walk) was the bug we're closing — it hammered users with
  // thousands of irrelevant files and made 404'd phantom users
  // (issue #1) crawl forever. If neither root is configured we set
  // a clear last_error and let the worker mark the job failed.
  if (roots.length === 0) {
    throw new Error(
      `no crawl scope: user has no "${personalFolderName()}" folder in their Drive ` +
        `(create one or have an admin set RAG_KNOWLEDGE_BASE_FOLDER_ID)`,
    )
  }

  const files = await listAllUserFiles(accessToken, roots)

  let filesChanged = 0
  let filesFailed = 0
  const seenFileIds: string[] = []
  const newDocIds: string[] = []

  for (const file of files) {
    // Per-file failures (transient Drive 5xx, RAGFlow upload rejection,
    // export size limit, etc.) are isolated — log and continue. Killing
    // the whole crawl on one bad file used to be the dominant failure
    // mode (issue #4). The user_file_access INSERT below is a no-op when
    // the rag.files row doesn't exist yet, so a never-ingested file just
    // stays uncatalogued without blocking the rest of the run.
    seenFileIds.push(file.id)
    try {
      const result = await ingestOne(user.tenant_id, dataset.id, dataset.ragflow_dataset_id, accessToken, file)
      if (result.changed) filesChanged++
      if (result.newDocId) newDocIds.push(result.newDocId)
    } catch (err) {
      filesFailed++
      console.warn(
        `[crawler] ingest failed for ${file.id} (${file.mimeType}) "${file.name}":`,
        (err as Error).message,
      )
    }

    await pool.query(
      `INSERT INTO rag.user_file_access (user_id, file_id, last_checked_at)
       SELECT $1, f.id, NOW() FROM rag.files f
        WHERE f.tenant_id = $2 AND f.gdrive_file_id = $3
       ON CONFLICT (user_id, file_id) DO UPDATE SET last_checked_at = NOW()`,
      [user.id, user.tenant_id, file.id],
    )
  }
  if (filesFailed > 0) {
    console.warn(`[crawler] ${filesFailed}/${files.length} files failed for user ${user.chat_user_id}`)
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
  // this they sit in 'UNSTART' state and `/api/v1/query` 500s with
  // `KeyError('id')` for any query that touches them. A parse failure
  // here propagates: the worker (index.ts processOne) catches and marks
  // the job `failed` with the error in `rag.users.last_error`, so the
  // chat-side status UI surfaces it instead of pretending the crawl
  // succeeded. Silent-swallow was the bug we're fixing.
  if (newDocIds.length > 0) {
    await parseDocuments(dataset.ragflow_dataset_id, newDocIds)
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
