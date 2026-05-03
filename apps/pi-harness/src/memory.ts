import { readdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises'
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
  try {
    const text = await readFile(path, 'utf8')
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ConversationLine)
  } catch {
    return []
  }
}

export async function listConversations(): Promise<string[]> {
  try {
    const files = await readdir(conversationsDir())
    return files.filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, ''))
  } catch {
    return []
  }
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
