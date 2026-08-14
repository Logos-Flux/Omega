import { readdir, readFile, rename, stat, writeFile, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// `WORKSPACE_ROOT` was originally captured once at module-load time.
// That breaks parallel-by-file unit tests, where each test sets its
// own temp dir before `bun:test` schedules it but the module graph is
// already shared (Bun caches `src/memory` between test files in a
// single `bun test` invocation, so whichever file imports first wins
// the env-var race). Resolving lazily on every call mirrors what
// `src/workspace.ts` and `src/profile.ts` already do for the same
// reason. The runtime cost is negligible — a string lookup per IO —
// and at runtime the env var is set once at boot and never changes,
// so the result is identical.
//
// `WORKSPACE_ROOT` is still exported as a constant for callers that
// only need a snapshot read (e.g. logging at boot). Anything that
// performs IO under the workspace should use the helpers below
// instead.
export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspace'

export function workspaceRoot(): string {
  return process.env.WORKSPACE_ROOT ?? '/workspace'
}
function conversationsDir(): string {
  return join(workspaceRoot(), 'conversations')
}
// Canonical global-memory path post I.C migration. The legacy
// /workspace/memory.md is moved here on first boot of the new
// harness build (see src/workspace.ts::migrateLegacyMemory).
function memoryFile(): string {
  return join(workspaceRoot(), 'memory', '_global.md')
}

export async function readSystemMemory(): Promise<string | null> {
  try {
    return await readFile(memoryFile(), 'utf8')
  } catch {
    return null
  }
}

export async function writeSystemMemory(content: string): Promise<void> {
  await writeFile(memoryFile(), content, 'utf8')
}

export async function appendSystemMemory(text: string): Promise<void> {
  await appendFile(memoryFile(), text.endsWith('\n') ? text : text + '\n', 'utf8')
}

export interface ConversationLine {
  ts: string
  role: 'user' | 'assistant'
  text: string
  provider?: string
  model?: string
  // Frame id of the originating turn. Optional for backwards compatibility
  // with legacy lines written before X.C; new entries always carry it.
  // Used by the rewind handler to find a truncation point.
  id?: string
  // True when an assistant message was cut short by a user-issued cancel
  // frame (X.C.1). The text reflects what the model produced up to the
  // abort; subsequent code (UI, history reconstruction, future audit
  // logging) can distinguish a complete reply from a half-finished one.
  partial?: boolean
}

export async function appendConversation(sessionId: string, line: ConversationLine): Promise<void> {
  const path = join(conversationsDir(), `${sessionId}.jsonl`)
  await appendFile(path, JSON.stringify(line) + '\n', 'utf8')
}

export async function readConversation(sessionId: string): Promise<ConversationLine[]> {
  const path = join(conversationsDir(), `${sessionId}.jsonl`)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    // No file yet (new session) — empty history.
    return []
  }
  // BUG-18 — parse line-by-line and SKIP corrupt lines rather than letting a
  // single bad JSON line (a partial append after a crash, a truncated write)
  // collapse the entire conversation to []. Losing one line is recoverable;
  // losing the whole thread silently is not.
  const out: ConversationLine[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      out.push(JSON.parse(line) as ConversationLine)
    } catch {
      console.warn(`[memory] skipping corrupt conversation line in ${sessionId}.jsonl`)
    }
  }
  return out
}

export async function listConversations(): Promise<string[]> {
  try {
    const files = await readdir(conversationsDir())
    return files.filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, ''))
  } catch {
    return []
  }
}

export interface ConversationMeta {
  id: string
  /** First user message, trimmed to a one-line title. null if the session has no user turn yet. */
  title: string | null
  /** ISO timestamp of the file's last write — used to sort newest-first. */
  updatedAt: string
  messageCount: number
}

/**
 * List every conversation on this (single-user) sprite with enough metadata to
 * render a thread switcher: a title derived from the first user message, the
 * last-modified time, and a message count. Empty sessions (no lines) are
 * dropped — they're the just-minted shells that haven't been used.
 *
 * Single-user-sprite note: every jsonl here belongs to the one user the sprite
 * was provisioned for, so returning all of them to a holder of a valid user
 * token is the user's own data (see the caller in index.ts — this supersedes
 * the earlier SEC-07 single-session scoping, which was over-strict for the
 * per-user-sprite model and made past chats unreachable).
 */
export async function listConversationsWithMeta(): Promise<ConversationMeta[]> {
  const ids = await listConversations()
  const metas = await Promise.all(
    ids.map(async (id): Promise<ConversationMeta | null> => {
      const lines = await readConversation(id)
      if (lines.length === 0) return null
      const firstUser = lines.find((l) => l.role === 'user')
      const title = firstUser ? firstUser.text.replace(/\s+/g, ' ').trim().slice(0, 80) : null
      let updatedAt: string
      try {
        updatedAt = (await stat(join(conversationsDir(), `${id}.jsonl`))).mtime.toISOString()
      } catch {
        updatedAt = lines[lines.length - 1]?.ts ?? new Date(0).toISOString()
      }
      return { id, title, updatedAt, messageCount: lines.length }
    }),
  )
  return metas
    .filter((m): m is ConversationMeta => m !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/**
 * Truncate a conversation file so that the entry whose `id` matches
 * `toMessageId` is the last surviving line (everything after it is
 * removed). Returns true if the truncation happened, false if the id
 * was not found.
 *
 * Atomic: writes the surviving prefix to a sibling tmp file and renames
 * over the original so a crash mid-rewind leaves either the old file
 * or the fully-truncated new one — never a half-written file.
 *
 * If the file does not exist, returns false (nothing to rewind to).
 */
export async function truncateConversationAt(
  sessionId: string,
  toMessageId: string,
): Promise<boolean> {
  const path = join(conversationsDir(), `${sessionId}.jsonl`)
  if (!existsSync(path)) return false
  const lines = await readConversation(sessionId)
  const idx = lines.findIndex((l) => l.id === toMessageId)
  if (idx === -1) return false
  const kept = lines.slice(0, idx + 1)
  const body = kept.map((l) => JSON.stringify(l)).join('\n') + (kept.length > 0 ? '\n' : '')
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, body, 'utf8')
  await rename(tmp, path)
  return true
}
