import type { Pool } from 'pg'
import { getPool, hasDatabase } from './db'

/**
 * Per-thread provider lock-in (ROADMAP I.D.1).
 *
 * A thread's `provider` + `model` columns capture the pair the user was on
 * when the first turn of that thread landed. Subsequent turns inherit the
 * locked value so prompt caching (Anthropic / Gemini) actually pays off;
 * mid-thread switches cost a re-fill of the cache.
 *
 * Behaviour:
 *  - Thread does not yet exist OR its lock is NULL (legacy / pre-first-turn):
 *    insert/update the row to lock to (requestedProvider, requestedModel).
 *    Returns { provider: requested, model: requested, mismatched: false }.
 *  - Thread is locked AND request matches AND no override: pass-through.
 *    Returns { provider: locked, model: locked, mismatched: false }.
 *  - Thread is locked AND request differs AND override === false:
 *    DO NOT update the row. The caller will silently use the locked pair
 *    for this turn. Returns { provider: locked, model: locked,
 *    mismatched: true }. Downstream surfaces the mismatch via response
 *    headers so the UI can prompt "switching invalidates cache".
 *  - Thread is locked AND request differs AND override === true:
 *    update the row to the new pair (re-lock). Returns
 *    { provider: requested, model: requested, mismatched: false }.
 *
 * The `title` is set to the first user message on first turn only; after
 * that the column is left untouched so a user-renamed thread stays renamed.
 */
/**
 * Thrown when a turn references a thread id that exists but is owned by a
 * different user (BUG-12). The caller must treat this as a 404 and MUST NOT
 * persist any messages against the thread.
 */
export class ThreadOwnershipError extends Error {
  constructor() {
    super('thread is owned by a different user')
    this.name = 'ThreadOwnershipError'
  }
}

export interface LockResolution {
  /** Provider/model the caller should ACTUALLY use for this turn. */
  provider: string
  model: string
  /**
   * True iff the request specified a provider/model pair that disagreed
   * with the persisted lock and `override` was not set. The caller used
   * the locked pair anyway; the UI uses this to render the "switching
   * invalidates cache" indicator.
   */
  mismatched: boolean
}

interface ResolveThreadLockArgs {
  threadId: string
  userId: string
  requestedProvider: string
  requestedModel: string
  override: boolean
  /** First user message text — only used as the thread title on creation. */
  firstUserMessage?: string
  /** Injectable for tests; defaults to the shared pool. */
  pool?: Pool
}

export async function resolveThreadLock(args: ResolveThreadLockArgs): Promise<LockResolution> {
  const { threadId, userId, requestedProvider, requestedModel, override, firstUserMessage } = args

  // Without a database we can't enforce locks. Behave as if every turn is the
  // first turn of an unlocked thread — the request wins. Tests can still cover
  // the locking path by injecting a `pool`.
  if (!hasDatabase && !args.pool) {
    return { provider: requestedProvider, model: requestedModel, mismatched: false }
  }
  const pool = args.pool ?? getPool()

  const existing = await pool.query<{ provider: string | null; model: string | null }>(
    `SELECT provider, model FROM chat.threads WHERE id = $1 AND user_id = $2`,
    [threadId, userId],
  )

  // First turn of this thread — create it AND lock to the requested pair.
  if (existing.rows.length === 0) {
    const title = firstUserMessage ? firstUserMessage.slice(0, 80) : 'New chat'
    // BUG-12 — the user-scoped SELECT above returned no row, which means EITHER
    // the thread is brand new OR it exists under a *different* user. The
    // `WHERE chat.threads.user_id = EXCLUDED.user_id` guard makes the
    // DO UPDATE a no-op for a foreign-owned row, so a client-supplied thread
    // id can no longer mutate (reorder / lock provider on) another user's
    // thread. `RETURNING id` then yields 0 rows in exactly that case → reject.
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO chat.threads (id, user_id, title, provider, model)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         updated_at = NOW(),
         provider = COALESCE(chat.threads.provider, EXCLUDED.provider),
         model = COALESCE(chat.threads.model, EXCLUDED.model)
       WHERE chat.threads.user_id = EXCLUDED.user_id
       RETURNING id`,
      [threadId, userId, title, requestedProvider, requestedModel],
    )
    if (ins.rows.length === 0) throw new ThreadOwnershipError()
    return { provider: requestedProvider, model: requestedModel, mismatched: false }
  }

  const row = existing.rows[0]!
  // Legacy thread (created before the lock columns existed) — first locked turn.
  if (row.provider === null || row.model === null) {
    await pool.query(
      `UPDATE chat.threads SET provider = $1, model = $2, updated_at = NOW()
       WHERE id = $3 AND user_id = $4`,
      [requestedProvider, requestedModel, threadId, userId],
    )
    return { provider: requestedProvider, model: requestedModel, mismatched: false }
  }

  const matches = row.provider === requestedProvider && row.model === requestedModel
  if (matches) {
    // Touch updated_at so thread list ordering reflects activity.
    await pool.query(
      `UPDATE chat.threads SET updated_at = NOW() WHERE id = $1 AND user_id = $2`,
      [threadId, userId],
    )
    return { provider: row.provider, model: row.model, mismatched: false }
  }

  // Mismatch. Either override (re-lock) or silently pin to the locked pair.
  if (override) {
    await pool.query(
      `UPDATE chat.threads SET provider = $1, model = $2, updated_at = NOW()
       WHERE id = $3 AND user_id = $4`,
      [requestedProvider, requestedModel, threadId, userId],
    )
    return { provider: requestedProvider, model: requestedModel, mismatched: false }
  }

  await pool.query(
    `UPDATE chat.threads SET updated_at = NOW() WHERE id = $1 AND user_id = $2`,
    [threadId, userId],
  )
  return { provider: row.provider, model: row.model, mismatched: true }
}
