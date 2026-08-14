import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { uploadPath } from './uploads'

// Shared-Drive-aware Google Drive access for the agent.
//
// The `gdcli` connector omits `supportsAllDrives`/`includeItemsFromAllDrives` on
// every Drive call, so it only sees "My Drive" and is BLIND to Shared Drives —
// which is where the KB lives. These tools hit the Drive v3 REST API
// directly with those flags set, using a per-user access token minted by the
// controller (so they carry the user's own permissions + the full-drive scope).
//
// REST (not the `googleapis` SDK) on purpose: keeps the golden bundle small.

const DRIVE = 'https://www.googleapis.com/drive/v3'
const SHARED = 'supportsAllDrives=true&includeItemsFromAllDrives=true'

const controllerBase = (): string => (process.env.CONTROLLER_BASE_URL ?? '').replace(/\/+$/, '')
// SEC-01 — the per-sprite, userId-scoped mint token the controller injected at
// provision time (signed with a key the Sprite never holds). It replaces the
// fleet-shared CONTROLLER_SERVICE_TOKEN as the harness's mint credential.
const mintToken = (): string => process.env.CONTROLLER_MINT_TOKEN ?? ''

// Drive tools need the controller to mint the user's Google token. Without the
// controller base URL + the per-sprite mint token they can't authenticate, so
// they don't register.
export function isDriveEnabled(): boolean {
  return controllerBase().length > 0 && mintToken().length > 0
}

async function getDriveToken(userId: string): Promise<string> {
  // SEC-01: authenticate the mint with the per-sprite mint token. It encodes
  // exactly this Sprite's userId, so the controller can only ever mint THIS
  // user's Google token — a connector call can't be steered to mint another
  // user's token even if the agent exfiltrates the Sprite env.
  const res = await fetch(`${controllerBase()}/api/oauth/google/access-token`, {
    method: 'POST',
    headers: {
      'x-mint-token': mintToken(),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ userId }),
  })
  if (!res.ok) {
    const t = (await res.text()).replace(/\s+/g, ' ').slice(0, 160)
    if (res.status === 404) throw new Error('Google is not connected for this user (have them connect Google first).')
    throw new Error(`drive token mint ${res.status}: ${t}`)
  }
  const body = (await res.json()) as { access_token?: string }
  if (!body.access_token) throw new Error('controller mint response missing access_token')
  return body.access_token
}

async function driveGet(token: string, path: string): Promise<Response> {
  return fetch(`${DRIVE}${path}`, { headers: { authorization: `Bearer ${token}` } })
}

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
  webViewLink?: string
}

// Find files by name or full-text across My Drive AND every Shared Drive.
export async function searchDrive(userId: string, query: string, limit = 10): Promise<DriveFile[]> {
  const token = await getDriveToken(userId)
  const safe = query.replace(/'/g, "\\'")
  const q = `(name contains '${safe}' or fullText contains '${safe}') and trashed = false`
  const fields = 'files(id,name,mimeType,modifiedTime,webViewLink)'
  const res = await driveGet(
    token,
    `/files?q=${encodeURIComponent(q)}&${SHARED}&corpora=allDrives&pageSize=${Math.min(limit, 50)}&fields=${encodeURIComponent(fields)}`,
  )
  if (!res.ok) throw new Error(`drive search ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const body = (await res.json()) as { files?: DriveFile[] }
  return body.files ?? []
}

// Google-native types export to text the model can read inline.
const NATIVE_EXPORT: Record<string, { mime: string }> = {
  'application/vnd.google-apps.document': { mime: 'text/markdown' },
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv' },
  'application/vnd.google-apps.presentation': { mime: 'text/plain' },
}

const MAX_INLINE_TEXT = 200_000

export interface FetchResult {
  name: string
  mimeType: string
  text?: string
  savedPath?: string
  savedAs?: string
  note?: string
}

// Fetch the FULL content of one file (Shared-Drive aware). Google Docs/Sheets/
// Slides are exported to text inline; binary files (PDF/docx/…) are saved to the
// session uploads dir so the agent can run `exec pdftotext`/`pandoc` on them or
// the user can download them.
export async function fetchFile(userId: string, fileId: string, sessionId: string): Promise<FetchResult> {
  const token = await getDriveToken(userId)
  const metaRes = await driveGet(token, `/files/${fileId}?${SHARED}&fields=id,name,mimeType`)
  if (!metaRes.ok) throw new Error(`drive metadata ${metaRes.status}: ${(await metaRes.text()).slice(0, 160)}`)
  const meta = (await metaRes.json()) as { name: string; mimeType: string }

  const native = NATIVE_EXPORT[meta.mimeType]
  if (native) {
    const ex = await driveGet(token, `/files/${fileId}/export?mimeType=${encodeURIComponent(native.mime)}`)
    if (!ex.ok) throw new Error(`drive export ${ex.status}: ${(await ex.text()).slice(0, 160)}`)
    const text = await ex.text()
    const truncated = text.length > MAX_INLINE_TEXT
    return {
      name: meta.name,
      mimeType: meta.mimeType,
      text: text.slice(0, MAX_INLINE_TEXT),
      ...(truncated ? { note: `Truncated to ${MAX_INLINE_TEXT} chars.` } : {}),
    }
  }

  const dl = await driveGet(token, `/files/${fileId}?alt=media&${SHARED}`)
  if (!dl.ok) throw new Error(`drive download ${dl.status}: ${(await dl.text()).slice(0, 160)}`)
  const buf = Buffer.from(await dl.arrayBuffer())
  // Save via the SAME path the harness's list/read/download endpoints use
  // (uploadPath → safeFilename), so the file the agent references is the file
  // the download link resolves. Writing our own sanitized name silently broke
  // downloads (spaces vs `_`).
  const savedPath = uploadPath(sessionId, meta.name)
  const savedName = basename(savedPath)
  await mkdir(dirname(savedPath), { recursive: true })
  await writeFile(savedPath, buf)
  return {
    name: meta.name,
    mimeType: meta.mimeType,
    savedPath,
    savedAs: savedName,
    note: `Binary (${(buf.length / 1024).toFixed(0)} KB) saved to this session's uploads as "${savedName}" — use that exact name. To read it: exec pdftotext "${savedName}" - (PDF) or pandoc "${savedName}" -t markdown (docx). It's also listed in list_uploads and downloadable by the user.`,
  }
}

export interface CommentResult {
  id: string
  content: string
}

// Add a review comment to a Drive file (Google Doc, etc.). The comment is
// attributed to the user (it's their token). Unanchored (whole-file) — put the
// section reference in the text. The closest API-native analog to a tracked-
// changes "suggestion" the user can read + resolve.
export async function addComment(userId: string, fileId: string, content: string): Promise<CommentResult> {
  const token = await getDriveToken(userId)
  const res = await fetch(`${DRIVE}/files/${fileId}/comments?${SHARED}&fields=id,content`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  if (!res.ok) throw new Error(`drive comment ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return (await res.json()) as CommentResult
}

export interface CopyResult {
  id: string
  name: string
  webViewLink?: string
}

// Server-side copy of a file (Shared-Drive aware). Optionally rename + place in a
// target folder. gdcli has no copy command and can't see Shared Drives at all.
export async function copyFile(
  userId: string,
  fileId: string,
  newName?: string,
  parentFolderId?: string,
): Promise<CopyResult> {
  const token = await getDriveToken(userId)
  const body: { name?: string; parents?: string[] } = {}
  if (newName) body.name = newName
  if (parentFolderId) body.parents = [parentFolderId]
  const res = await fetch(`${DRIVE}/files/${fileId}/copy?${SHARED}&fields=id,name,webViewLink`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`drive copy ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return (await res.json()) as CopyResult
}
