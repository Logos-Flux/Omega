import { getPool, hasDatabase } from './db'
import { signSessionToken } from './jwt'
import { backupConfigured, putBackup } from './backup-storage'

// OPS-14 — back up a user's sprite /workspace data (conversation jsonl + the
// persistent memory store) to Tigris, so it survives a sprite destroy
// (sprite-janitor) or loss. The data lives ONLY on the sprite — it is NOT in the
// Fly-MPG-backed Postgres — so without this it's gone the moment a sprite is
// reaped. Read entirely through the harness's existing HTTP endpoints
// (/conversations, /conversations/:id, /memory), so no golden/harness change is
// needed; the controller already holds HARNESS_JWT_SECRET to mint a token.

interface ContainerRow {
  user_id: string
  http_url: string | null
  status: string
  container_name: string
}

export interface ExportResult {
  userId: string
  status: 'exported' | 'skipped'
  reason?: string
  conversations?: number
  bytes?: number
  key?: string
}

const HARNESS_TIMEOUT_MS = 20_000

async function harnessGet<T>(baseUrl: string, path: string, token: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(HARNESS_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`harness ${path} → ${res.status}`)
  return (await res.json()) as T
}

/**
 * Export one user's workspace to Tigris under `<userId>/<ISO>.json`. Skips
 * (non-fatally) when the user has no usable sprite — a row that's still
 * provisioning, has no URL, or whose harness is unreachable isn't an error worth
 * failing a fleet sweep over.
 */
export async function exportUserWorkspace(userId: string, providerName = 'sprites'): Promise<ExportResult> {
  if (!hasDatabase) return { userId, status: 'skipped', reason: 'no database' }
  if (!backupConfigured()) throw new Error('backup storage not configured')

  const row = (
    await getPool().query<ContainerRow>(
      `SELECT user_id, http_url, status, container_name
       FROM pi.containers WHERE user_id = $1 AND provider = $2`,
      [userId, providerName],
    )
  ).rows[0]

  if (!row || row.status !== 'active' || !row.http_url) {
    return { userId, status: 'skipped', reason: row ? `status=${row.status}` : 'no container' }
  }

  // A short-lived token; /conversations + /memory are per-user (sessionId-
  // agnostic) on the single-user sprite, so any sessionId verifies.
  const token = signSessionToken({ userId, sessionId: 'backup', ttlSec: 300 })

  let conversations: Array<{ id: string; lines: unknown[] }>
  try {
    const list = await harnessGet<{ sessions: Array<{ id: string }> }>(row.http_url, '/conversations', token)
    conversations = []
    for (const s of list.sessions ?? []) {
      const conv = await harnessGet<{ id: string; lines: unknown[] }>(
        row.http_url,
        `/conversations/${encodeURIComponent(s.id)}`,
        token,
      )
      conversations.push({ id: s.id, lines: conv.lines ?? [] })
    }
  } catch (e) {
    // Harness cold/unreachable — skip rather than fail the sweep.
    return { userId, status: 'skipped', reason: `harness unreachable: ${(e as Error).message}` }
  }

  let memory = ''
  try {
    memory = (await harnessGet<{ memory: string }>(row.http_url, '/memory', token)).memory ?? ''
  } catch {
    // memory is best-effort; conversations are the primary payload.
  }

  const bundle = JSON.stringify({
    schema: 'sprite-backup/v1',
    userId,
    container: row.container_name,
    exportedAt: new Date().toISOString(),
    memory,
    conversations,
  })

  const key = `${userId}/${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  await putBackup(key, bundle)

  return { userId, status: 'exported', conversations: conversations.length, bytes: bundle.length, key }
}

/** Export every active sprite. Used by the nightly sweep action. */
export async function exportAllWorkspaces(providerName = 'sprites'): Promise<ExportResult[]> {
  if (!hasDatabase) return []
  const ids = (
    await getPool().query<{ user_id: string }>(
      `SELECT user_id FROM pi.containers WHERE provider = $1 AND status = 'active' AND http_url IS NOT NULL`,
      [providerName],
    )
  ).rows.map((r) => r.user_id)

  const results: ExportResult[] = []
  for (const id of ids) {
    try {
      results.push(await exportUserWorkspace(id, providerName))
    } catch (e) {
      results.push({ userId: id, status: 'skipped', reason: (e as Error).message })
    }
  }
  return results
}
