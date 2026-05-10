// Drive source — adapts gdrive.ts to the RagSource shape.
//
// Owns the per-user OAuth, the `my-ai`-folder resolution that used to
// live in crawler.ts, and the deprecated RAG_FOLDER_ALLOWLIST fallback.
// Everything else (file iteration semantics, download/export logic)
// stays in gdrive.ts unchanged.

import { getPool } from './db'
import { getDriveAccessToken } from './oauth'
import {
  downloadFile,
  findFolderByName,
  listAllUserFiles,
  type DriveFile,
} from './gdrive'
import type { DownloadResult, RagSource, SourceFile, SourceUser } from './source'

// Lazy env reads — same pattern as crawler.ts before the refactor and
// ragflow.ts. Top-level consts capture at module-load and break tests
// that override env per-process.
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
  user: SourceUser,
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
      `[drive-source] multiple "${name}" folders for user ${user.chat_user_id}; using oldest (${found.id})`,
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

function driveFileToSource(f: DriveFile): SourceFile {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    size: f.size,
    source: 'drive',
  }
}

async function listForUser(user: SourceUser): Promise<SourceFile[]> {
  const accessToken = await getDriveAccessToken(user.chat_user_id)

  // Compose crawl roots from up to three sources, in priority order:
  //   1. The user's personal folder (default name `my-ai`, configurable
  //      via RAG_PERSONAL_FOLDER_NAME). Resolved once and cached.
  //   2. The shared knowledge-base folder (RAG_KNOWLEDGE_BASE_FOLDER_ID).
  //   3. Legacy RAG_FOLDER_ALLOWLIST.
  const roots: string[] = []
  const myAiId = await resolveMyAiFolder(user, accessToken)
  if (myAiId) roots.push(myAiId)
  const kbId = knowledgeBaseFolderId()
  if (kbId) roots.push(kbId)
  const legacy = legacyAllowlist()
  if (legacy.length > 0) {
    console.warn(
      '[drive-source] RAG_FOLDER_ALLOWLIST is deprecated; switch to RAG_KNOWLEDGE_BASE_FOLDER_ID + per-user `my-ai` folders. ' +
        'This env will be removed in the next release.',
    )
    roots.push(...legacy)
  }

  // Refuse to whole-Drive walk. Earlier behaviour (empty allowlist →
  // full walk) was the bug we're closing — it hammered users with
  // thousands of irrelevant files. If neither root is configured we
  // surface a clear error and let the worker mark the job failed.
  if (roots.length === 0) {
    throw new Error(
      `no crawl scope: user has no "${personalFolderName()}" folder in their Drive ` +
        `(create one or have an admin set RAG_KNOWLEDGE_BASE_FOLDER_ID)`,
    )
  }

  const driveFiles = await listAllUserFiles(accessToken, roots)
  return driveFiles.map(driveFileToSource)
}

async function download(file: SourceFile, user: SourceUser): Promise<DownloadResult> {
  if (file.source !== 'drive') {
    throw new Error(`drive-source.download called with non-drive file (source=${file.source})`)
  }
  const accessToken = await getDriveAccessToken(user.chat_user_id)
  // Re-cast to DriveFile — the field shape matches by construction in
  // driveFileToSource above.
  const driveFile: DriveFile = {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    modifiedTime: file.modifiedTime,
    size: file.size,
  }
  return downloadFile(accessToken, driveFile)
}

export const driveSource: RagSource = {
  kind: 'drive',
  listForUser,
  download,
}
