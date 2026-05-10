// Filesystem source — walks an operator-provided directory tree.
//
// v0.6.0 layout: flat. Every file under RAG_FILES_DIR is ingested and
// every user in the tenant has access to every file. Per-user subdirs
// are deferred to v0.7.x as `RAG_FILESYSTEM_LAYOUT=per-user`.
//
// Safety rails:
//   - never follow symlinks (avoid /etc/passwd-style escapes)
//   - skip dotfiles (.git/, .DS_Store, .tmp.*)
//   - bound max walk depth (default 16)
//   - per-file try/catch — a bad file or permission error doesn't kill
//     the run
//   - resolve mime via extension lookup; unknown extensions are skipped
//     (rather than uploaded as octet-stream — wastes a RAGFlow upload
//     on something the parser can't read)
//
// Stable id = relative POSIX path under RAG_FILES_DIR, e.g.
// "handbook/chapter-1.md". POSIX separators regardless of host OS so an
// id moved between hosts (Linux ↔ macOS) compares equal.

import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { readdir, readFile, lstat } from 'node:fs/promises'
import path from 'node:path'
import type { DownloadResult, RagSource, SourceFile, SourceUser } from './source'
import { isIngestable, mimeFromFilename } from './mime'

// Lazy env reads — same pattern as ragflow.ts and drive-source.ts so
// per-process env overrides in tests work.
function filesDir(): string {
  const dir = process.env.RAG_FILES_DIR
  if (!dir) throw new Error('RAG_FILES_DIR not set (required when RAG_SOURCE=filesystem)')
  return path.resolve(dir)
}
function maxDepth(): number {
  const raw = process.env.RAG_FILESYSTEM_MAX_DEPTH
  if (!raw) return 16
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 16
}

function isDotfile(name: string): boolean {
  return name.startsWith('.')
}

interface WalkAccumulator {
  root: string
  out: SourceFile[]
  failed: Array<{ relativePath: string; reason: string }>
}

/**
 * Recursive walk. Manual rather than `readdir({ recursive: true })`
 * because we need per-entry symlink rejection (the recursive flag would
 * follow them).
 */
async function walk(
  acc: WalkAccumulator,
  absDir: string,
  depth: number,
): Promise<void> {
  if (depth > maxDepth()) {
    console.warn(
      `[filesystem] depth limit (${maxDepth()}) hit at ${path.relative(acc.root, absDir)}; stopping descent`,
    )
    return
  }
  let entries: Dirent<string>[]
  try {
    entries = (await readdir(absDir, { withFileTypes: true, encoding: 'utf8' })) as Dirent<string>[]
  } catch (err) {
    acc.failed.push({
      relativePath: path.relative(acc.root, absDir),
      reason: `readdir: ${(err as Error).message}`,
    })
    return
  }
  for (const entry of entries) {
    if (isDotfile(entry.name)) continue
    const abs = path.join(absDir, entry.name)
    if (entry.isSymbolicLink()) {
      // Documented invariant: filesystem walks NEVER follow symlinks.
      // Drop them silently — operators who want a file in here should
      // upload the real file, not a link to it.
      continue
    }
    if (entry.isDirectory()) {
      await walk(acc, abs, depth + 1)
      continue
    }
    if (!entry.isFile()) {
      // Sockets, FIFOs, devices — ignore.
      continue
    }
    try {
      // Re-stat with lstat to defend against a TOCTOU swap of the
      // dirent into a symlink between readdir and stat. If the lstat
      // disagrees with the dirent, skip.
      const st = await lstat(abs)
      if (!st.isFile()) continue

      const mimeType = mimeFromFilename(entry.name)
      if (!mimeType) {
        // Unknown extension — silent skip. Common case: README without
        // an extension, .lock files, build artifacts the operator left
        // in the tree by accident.
        continue
      }
      if (!isIngestable(mimeType)) continue

      const relPosix = posixRelative(acc.root, abs)
      acc.out.push({
        id: relPosix,
        name: entry.name,
        mimeType,
        modifiedTime: st.mtime.toISOString(),
        size: String(st.size),
        source: 'filesystem',
      })
    } catch (err) {
      acc.failed.push({
        relativePath: path.relative(acc.root, abs),
        reason: (err as Error).message,
      })
    }
  }
}

function posixRelative(root: string, abs: string): string {
  const rel = path.relative(root, abs)
  return rel.split(path.sep).join('/')
}

/**
 * Resolve a SourceFile.id back to an absolute path under RAG_FILES_DIR,
 * defending against `..` escapes. Never reveal the absolute path to
 * callers — the resolved path is internal only.
 */
function resolveSafe(root: string, id: string): string {
  // Reject absolute or scheme-prefixed ids outright.
  if (path.isAbsolute(id) || /^[a-z]+:/i.test(id)) {
    throw new Error(`filesystem source-id rejected (looks absolute): ${id}`)
  }
  const resolved = path.resolve(root, id)
  // Containment check: resolved must be inside root.
  const rel = path.relative(root, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`filesystem source-id escapes root: ${id}`)
  }
  return resolved
}

async function listForUser(_user: SourceUser): Promise<SourceFile[]> {
  // v0.6.0 flat layout: every user sees every file. The user is unused
  // here but kept in the signature for symmetry with drive-source and
  // forward compat with the v0.7.x per-user-subdir layout.
  const root = filesDir()
  const acc: WalkAccumulator = { root, out: [], failed: [] }
  await walk(acc, root, 0)
  if (acc.failed.length > 0) {
    // Log but don't throw — per-file failures shouldn't kill the run.
    // Aggregated to keep the log line count bounded on a deeply broken
    // tree.
    console.warn(
      `[filesystem] ${acc.failed.length} entries skipped:`,
      acc.failed.slice(0, 5),
    )
  }
  return acc.out
}

async function download(file: SourceFile, _user: SourceUser): Promise<DownloadResult> {
  if (file.source !== 'filesystem') {
    throw new Error(`filesystem.download called with non-filesystem file (source=${file.source})`)
  }
  const root = filesDir()
  const abs = resolveSafe(root, file.id)
  // lstat check defends against a symlink that materialised between
  // listForUser and download. Symlinks NEVER pass.
  const st = await lstat(abs)
  if (!st.isFile()) {
    throw new Error(`filesystem download target is not a regular file: ${file.id}`)
  }
  const body = await readFile(abs)
  return {
    body,
    filename: file.name,
    mimeType: file.mimeType,
  }
}

export const filesystemSource: RagSource = {
  kind: 'filesystem',
  listForUser,
  download,
}

// Exported only for tests.
export const _internal = {
  posixRelative,
  resolveSafe,
  hashBody: (body: Buffer) => createHash('sha256').update(body).digest('hex'),
}
