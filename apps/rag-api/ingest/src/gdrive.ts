// GDrive client. Per-user OAuth: each call takes the user's access
// token (minted by lib/oauth.ts in the API side, propagated to us via
// the same provider here).

import { google } from 'googleapis'

const FOLDER_MIME = 'application/vnd.google-apps.folder'

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

// List every file the user owns or has been granted access to.
//
// If `folderAllowlist` is non-empty, the walk is recursive but scoped
// to those folder IDs (and their subfolders). Useful both as a tenant
// scope ("only this company's shared drive") and as a per-tenant
// content allowlist. Empty/undefined → whole-drive walk.
//
// Skips Google-native folders themselves (we don't ingest folders).
// Native Docs/Sheets/Slides are kept — exporter handles them in
// downloadFile.
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
  if (f.id && f.name && f.mimeType && f.modifiedTime && f.mimeType !== FOLDER_MIME) {
    out.push({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      size: f.size ?? undefined,
      parents: f.parents ?? undefined,
    })
  }
}

const NATIVE_EXPORTS: Record<string, { mimeType: string; extension: string }> = {
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
