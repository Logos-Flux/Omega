import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { workspaceRoot } from './memory'

function uploadsDir(): string {
  return join(workspaceRoot(), 'uploads')
}
export const MAX_BYTES = 1_000_000 // 1MB
const SESSION_RX = /^[A-Za-z0-9_-]{1,80}$/

export interface UploadInfo {
  filename: string
  size: number
  contentType?: string
}

function safeFilename(name: string): string {
  return basename(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200)
}

function safeSessionId(sessionId: string): string {
  if (!SESSION_RX.test(sessionId)) throw new Error('invalid sessionId')
  return sessionId
}

export async function saveUpload(sessionId: string, file: File): Promise<UploadInfo> {
  if (file.size > MAX_BYTES) {
    throw new Error(`file too large: ${file.size} > ${MAX_BYTES}`)
  }
  const sid = safeSessionId(sessionId)
  const dir = join(uploadsDir(), sid)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  const filename = safeFilename(file.name || 'unnamed')
  const path = join(dir, filename)
  const buf = Buffer.from(await file.arrayBuffer())
  await writeFile(path, buf)
  return { filename, size: buf.length, contentType: file.type || undefined }
}

export async function listUploads(sessionId: string): Promise<UploadInfo[]> {
  const sid = safeSessionId(sessionId)
  const dir = join(uploadsDir(), sid)
  if (!existsSync(dir)) return []
  const names = await readdir(dir)
  const out: UploadInfo[] = []
  for (const name of names) {
    try {
      const s = await stat(join(dir, name))
      if (s.isFile()) out.push({ filename: name, size: s.size })
    } catch {
      // skip
    }
  }
  out.sort((a, b) => a.filename.localeCompare(b.filename))
  return out
}

export async function readUpload(sessionId: string, filename: string): Promise<string | null> {
  const sid = safeSessionId(sessionId)
  const safe = safeFilename(filename)
  const path = join(uploadsDir(), sid, safe)
  try {
    const buf = await readFile(path)
    if (buf.byteLength > MAX_BYTES) return null
    return buf.toString('utf8')
  } catch {
    return null
  }
}

export function uploadPath(sessionId: string, filename: string): string {
  return join(uploadsDir(), safeSessionId(sessionId), safeFilename(filename))
}

// Remove a single upload by name. Returns true if the file existed and
// was removed, false if it wasn't there. Path-safety mirrors saveUpload:
// `safeSessionId` rejects invalid session ids; `safeFilename` strips
// path components so a caller can't escape the session uploads dir.
export async function deleteUpload(sessionId: string, filename: string): Promise<boolean> {
  const sid = safeSessionId(sessionId)
  const safe = safeFilename(filename)
  const path = join(uploadsDir(), sid, safe)
  try {
    await unlink(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

const TEXT_MAX = 250_000 // 250 KB cap for tool-side writes
export async function writeUploadText(
  sessionId: string,
  filename: string,
  content: string,
): Promise<UploadInfo> {
  const sid = safeSessionId(sessionId)
  const dir = join(uploadsDir(), sid)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  const safe = safeFilename(filename || 'untitled.md')
  const path = join(dir, safe)
  const buf = Buffer.from(content, 'utf8')
  if (buf.byteLength > TEXT_MAX) {
    throw new Error(`content too large: ${buf.byteLength} > ${TEXT_MAX}`)
  }
  await writeFile(path, buf)
  return { filename: safe, size: buf.length, contentType: 'text/markdown' }
}
