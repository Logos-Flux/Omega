// GDrive client. Per-user OAuth: each call takes the user's access
// token (minted by lib/oauth.ts in the API side, propagated to us via
// the same provider here).

import { google } from 'googleapis'
import { FOLDER_MIME, NATIVE_EXPORTS, isIngestable } from './mime'

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  size?: string
  parents?: string[]
}

function driveClient(accessToken: string) {
  const auth = new google.auth.OAuth2()
  auth.setCredentials({ access_token: accessToken })
  return google.drive({ version: 'v3', auth })
}

// Find a folder by exact name in the user's own Drive (must be owner).
// Used to resolve each user's personal folder (default `my-ai`) on first
// sync. Restricting to `'me' in owners` avoids matching folders shared
// from elsewhere that happen to have the same name.
//
// Returns the folder id, or null if no match. With multiple matches we
// pick the oldest (first by createdTime) and log a warning — folder
// names aren't unique in Drive but the typical case is exactly one.
export async function findFolderByName(
  accessToken: string,
  name: string,
): Promise<{ id: string; ambiguous: boolean } | null> {
  const drive = driveClient(accessToken)
  // Single-quote escape so a name like `bob's docs` doesn't break the q.
  const safeName = name.replace(/'/g, "\\'")
  const res = await drive.files.list({
    q: `name = '${safeName}' and mimeType = '${FOLDER_MIME}' and trashed = false and 'me' in owners`,
    fields: 'files(id, name, createdTime)',
    orderBy: 'createdTime',
    pageSize: 10,
    spaces: 'drive',
  })
  const files = res.data.files ?? []
  const first = files[0]
  if (!first?.id) return null
  return { id: first.id, ambiguous: files.length > 1 }
}

// List every file the user owns or has been granted access to.
//
// If `folderAllowlist` is non-empty, the walk is recursive but scoped
// to those folder IDs (and their subfolders). Useful both as a tenant
// scope ("only this company's shared drive") and as a per-tenant
// content allowlist. Empty/undefined → whole-drive walk.
//
// Skips folders (we don't ingest them directly — walkFolder recurses)
// and any Google-native type we don't have an exporter for. Native
// Docs/Sheets/Slides pass through; downloadFile exports them. See
// `isIngestable` below for the exact filter.
export async function listAllUserFiles(
  accessToken: string,
  folderAllowlist?: string[],
): Promise<DriveFile[]> {
  const drive = driveClient(accessToken)

  if (folderAllowlist && folderAllowlist.length > 0) {
    const out: DriveFile[] = []
    const visited = new Set<string>()
    for (const root of folderAllowlist) {
      await walkFolder(drive, root, out, visited)
    }
    return out
  }

  // Whole-drive fallback: every file the user can see, anywhere.
  const out: DriveFile[] = []
  let pageToken: string | undefined
  do {
    const res = await drive.files.list({
      q: `trashed = false and mimeType != '${FOLDER_MIME}'`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size, parents)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
    })
    for (const f of res.data.files ?? []) {
      pushIfFile(f, out)
    }
    pageToken = res.data.nextPageToken ?? undefined
  } while (pageToken)
  return out
}

async function walkFolder(
  drive: ReturnType<typeof driveClient>,
  folderId: string,
  out: DriveFile[],
  visited: Set<string>,
): Promise<void> {
  if (visited.has(folderId)) return
  visited.add(folderId)

  let pageToken: string | undefined
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size, parents)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    for (const f of res.data.files ?? []) {
      if (!f.id) continue
      if (f.mimeType === FOLDER_MIME) {
        await walkFolder(drive, f.id, out, visited)
      } else {
        pushIfFile(f, out)
      }
    }
    pageToken = res.data.nextPageToken ?? undefined
  } while (pageToken)
}

type DriveApiFile = {
  id?: string | null
  name?: string | null
  mimeType?: string | null
  modifiedTime?: string | null
  size?: string | null
  parents?: string[] | null
}

function pushIfFile(f: DriveApiFile, out: DriveFile[]): void {
  if (!(f.id && f.name && f.mimeType && f.modifiedTime)) return
  if (!isIngestable(f.mimeType)) return
  out.push({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    size: f.size ?? undefined,
    parents: f.parents ?? undefined,
  })
}

export interface DownloadResult {
  body: Buffer
  filename: string
  mimeType: string
}

// Download a file. Handles Google-native types via export.
export async function downloadFile(
  accessToken: string,
  file: DriveFile,
): Promise<DownloadResult> {
  const drive = driveClient(accessToken)
  const native = NATIVE_EXPORTS[file.mimeType]
  if (native) {
    const res = await drive.files.export(
      { fileId: file.id, mimeType: native.mimeType },
      { responseType: 'arraybuffer' },
    )
    return {
      body: Buffer.from(res.data as ArrayBuffer),
      filename: file.name + native.extension,
      mimeType: native.mimeType,
    }
  }
  const res = await drive.files.get(
    { fileId: file.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  )
  return {
    body: Buffer.from(res.data as ArrayBuffer),
    filename: file.name,
    mimeType: file.mimeType,
  }
}
