// Source abstraction for the rag-ingest crawler.
//
// A `RagSource` is the thing that knows how to enumerate and download
// files for a given user. Two implementations:
//   - drive-source.ts wraps gdrive.ts (per-user Drive crawl)
//   - filesystem.ts walks a host-local directory tree
//
// The crawler picks one at startup via RAG_SOURCE; all source-specific
// logic (auth, scope resolution, download) lives behind this interface
// so crawler.ts stays source-agnostic.

import { isIngestable as mimeIngestable } from './mime'

export type SourceKind = 'drive' | 'filesystem'

export interface SourceFile {
  /**
   * Stable per-source identifier. Used as `rag.files.source_id`.
   *   drive:      file.id (Drive's opaque id)
   *   filesystem: relative POSIX path under RAG_FILES_DIR (e.g.
   *               "handbook/chapter-1.md")
   * IDs are NOT comparable across sources — `(source_kind, source_id)`
   * is the actual uniqueness key.
   */
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  size?: string
  source: SourceKind
}

export interface DownloadResult {
  body: Buffer
  filename: string
  mimeType: string
}

/**
 * Minimal user shape passed to source methods. The Drive source uses
 * `chat_user_id` to mint an OAuth token; the filesystem source ignores
 * the user under the v0.6.0 flat layout (every user sees every file)
 * but takes it as a parameter for symmetry and forward compat with the
 * v0.7.x per-user-subdir layout.
 */
export interface SourceUser {
  id: string
  tenant_id: string
  chat_user_id: string
  gdrive_my_ai_folder_id: string | null
  gdrive_my_ai_status: 'unknown' | 'present' | 'missing'
}

export interface RagSource {
  kind: SourceKind
  /** List every ingestable file the user can see. */
  listForUser(user: SourceUser): Promise<SourceFile[]>
  /** Download the file's bytes plus the filename + mime to upload as. */
  download(file: SourceFile, user: SourceUser): Promise<DownloadResult>
}

/**
 * Reuse the shared mimetype gate. Re-exported here so callers that
 * already import from this module don't also need to know about mime.ts.
 */
export const isIngestable = mimeIngestable

/**
 * Pick the source impl from RAG_SOURCE. Lazy import so a `filesystem`
 * deploy doesn't pay the googleapis startup cost. Default 'drive'
 * preserves backwards compat — every existing deploy keeps
 * working without a config change.
 *
 * 'both' mode (drive + filesystem in the same crawl) is reserved for
 * v0.6.x — explicitly rejected here so an operator who sets it gets a
 * clear error rather than silent drive-only behavior.
 */
export async function pickSource(): Promise<RagSource> {
  const raw = (process.env.RAG_SOURCE ?? 'drive').trim().toLowerCase()
  if (raw === 'drive' || raw === '') {
    const { driveSource } = await import('./drive-source')
    return driveSource
  }
  if (raw === 'filesystem') {
    const { filesystemSource } = await import('./filesystem')
    return filesystemSource
  }
  if (raw === 'both') {
    throw new Error(
      `RAG_SOURCE=both is reserved for a future release; use 'drive' or 'filesystem'`,
    )
  }
  throw new Error(`unknown RAG_SOURCE=${raw} (expected 'drive' or 'filesystem')`)
}
