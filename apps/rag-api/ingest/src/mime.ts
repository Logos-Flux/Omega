// Mime helpers shared by the Drive and filesystem sources.
//
// `isIngestable` is the gate the listing side uses to decide which files
// reach the per-file ingest loop. Both sources share the same allowlist
// (folders out, Google-native types only when we have an exporter,
// ordinary binary mimes pass) so swapping sources doesn't change the
// ingestable surface.
//
// `mimeFromFilename` is the filesystem source's mime resolver — disk
// files have no `mimeType` attribute, only an extension. The map is
// intentionally small: it covers what RAGFlow actually wants to parse,
// and unknown extensions return null so `isIngestable` can skip them.

export const FOLDER_MIME = 'application/vnd.google-apps.folder'
const NATIVE_PREFIX = 'application/vnd.google-apps.'

export interface NativeExport {
  mimeType: string
  extension: string
}

// Drive's Google-native types that we know how to export. The Drive
// download path uses the values; `isIngestable` uses just the keys.
export const NATIVE_EXPORTS: Record<string, NativeExport> = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: '.pptx',
  },
}

// True for files we can actually feed into the pipeline. Folders are out
// (we don't ingest them directly — walkFolder recurses). Google-native
// types are in only if we have an exporter; Drawings, Forms, Scripts,
// Shortcuts, Sites, etc. are silently skipped because trying to download
// them via files.get(alt:'media') fails with "Only files with binary
// content can be downloaded" and previously killed the whole crawl.
// Ordinary binary mimetypes always pass.
export function isIngestable(mimeType: string): boolean {
  if (mimeType === FOLDER_MIME) return false
  if (mimeType.startsWith(NATIVE_PREFIX)) {
    return Object.prototype.hasOwnProperty.call(NATIVE_EXPORTS, mimeType)
  }
  return true
}

// Filename → mime. Lowercased extension lookup. Unknown extensions
// return null; the filesystem walker treats null as "skip this file"
// rather than guessing `application/octet-stream` (a guess that would
// then pass `isIngestable` and waste a RAGFlow upload on something
// the parser can't read).
const EXTENSION_MIME: Record<string, string> = {
  // PDFs and office docs.
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Plain-text family.
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  // Code that's also fine as text.
  '.js': 'text/javascript',
  '.ts': 'text/x-typescript',
  '.py': 'text/x-python',
  '.sh': 'application/x-sh',
  '.sql': 'application/sql',
  // Images — RAGFlow OCRs or skips depending on its config.
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

export function mimeFromFilename(filename: string): string | null {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return null
  const ext = filename.slice(dot).toLowerCase()
  return EXTENSION_MIME[ext] ?? null
}
