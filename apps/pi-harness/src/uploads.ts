import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { workspaceRoot } from './memory'

function uploadsDir(): string {
  return join(workspaceRoot(), 'uploads')
}
// Default raised from 1 MB → 100 MB on 2026-05-14 — 1 MB rejected any
// real-world doc. Override via `MAX_UPLOAD_BYTES` env on the harness
// (controller's provision-user/update-user pass-through if you want it
// non-default per-deploy). Must be at least as permissive as the client
// cap in chat-frontend's `harness-utils.ts:MAX_UPLOAD_BYTES`.
export const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 100_000_000
const SESSION_RX = /^[A-Za-z0-9_-]{1,80}$/

export interface UploadInfo {
  filename: string
  size: number
  contentType?: string
}

function safeFilename(name: string): string {
  const base = basename(name)
  const sanitized = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200)
  // BUG-14 — when sanitization was LOSSY (e.g. two different CJK names both
  // collapse to "__.pdf"), distinct uploads would map to the same path and
  // silently overwrite each other. Append a short hash of the ORIGINAL name
  // so the mapping stays injective. Names that survive sanitization unchanged
  // keep their exact filename (no hash noise).
  if (sanitized === base) return sanitized
  const h = createHash('sha256').update(base).digest('hex').slice(0, 8)
  const dot = sanitized.lastIndexOf('.')
  return dot > 0 ? `${sanitized.slice(0, dot)}-${h}${sanitized.slice(dot)}` : `${sanitized}-${h}`
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
