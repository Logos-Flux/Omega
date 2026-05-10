// Filesystem-mode Connectors pane. Body of <RAGSourceCard> when
// mode === 'filesystem'. Self-fetches /api/rag/status; the parent has
// already resolved /api/rag/enabled and /api/rag/source for us.
//
// State machine:
//
//   loading-status     → spinner under the card header
//   error              → 4xx/5xx from /status; show + Retry
//   missing            → filesystem_status === 'missing' (operator hasn't
//                        provisioned the source dir yet — prompt them)
//   empty              → file_count === 0, no in-flight job; "Sync"
//   syncing            → in_flight_job_id set; spinner + polling
//   synced             → file_count + relative time + "Sync now" + "Forget"
//
// Critically, **the actual filesystem path is never rendered**. The /status
// endpoint doesn't expose it (only the count), and we don't ask. The path
// may carry internal infrastructure details and shouldn't leak into a
// browser tab anyone could screenshot.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  forgetRag,
  getRagStatus,
  triggerRagSync,
  type RagStatus,
} from '../lib/rag-api'

const POLL_INTERVAL_MS = 3000

type ViewState =
  | { kind: 'loading-status' }
  | { kind: 'error'; message: string }
  | { kind: 'missing'; status: RagStatus }
  | { kind: 'empty'; status: RagStatus }
  | { kind: 'syncing'; status: RagStatus }
  | { kind: 'synced'; status: RagStatus }

function deriveView(status: RagStatus): Exclude<ViewState, { kind: 'loading-status' | 'error' }> {
  // 'missing' fires when a v0.7.x per-user-subdir layout is configured
  // but the operator hasn't created the user's subdir yet. Under the
  // v0.6.0 flat layout filesystem_status stays 'unknown', so this
  // branch never fires there — but we still respect 'missing' so a
  // future schema change doesn't silently render the wrong pane.
  if (status.filesystem_status === 'missing') return { kind: 'missing', status }
  if (status.in_flight_job_id) return { kind: 'syncing', status }
  if ((status.filesystem_file_count ?? 0) === 0) return { kind: 'empty', status }
  return { kind: 'synced', status }
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return iso
  const diffMs = Date.now() - t
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function FilesystemPane() {
  const [view, setView] = useState<ViewState>({ kind: 'loading-status' })
  const [busy, setBusy] = useState(false)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelled = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const status = await getRagStatus()
      if (cancelled.current) return
      setView(deriveView(status))
      if (status.in_flight_job_id) {
        pollTimer.current = setTimeout(() => {
          if (!cancelled.current) void refresh()
        }, POLL_INTERVAL_MS)
      }
    } catch (err) {
      if (cancelled.current) return
      setView({ kind: 'error', message: (err as Error).message })
    }
  }, [])

  useEffect(() => {
    cancelled.current = false
    void refresh()
    return () => {
      cancelled.current = true
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
  }, [refresh])

  const onSync = useCallback(async () => {
    setBusy(true)
    try {
      await triggerRagSync(false)
      await refresh()
    } catch (err) {
      setView({ kind: 'error', message: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const onForget = useCallback(async () => {
    if (!window.confirm("Forget this user's filesystem-source index? The files on disk are untouched; the index can be rebuilt with Sync now.")) return
    setBusy(true)
    try {
      await forgetRag()
      await refresh()
    } catch (err) {
      setView({ kind: 'error', message: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }, [refresh])

  if (view.kind === 'loading-status') {
    return <p className="text-sm text-t-muted">Loading…</p>
  }
  if (view.kind === 'error') {
    return <ErrorPane message={view.message} onRetry={() => void refresh()} />
  }
  if (view.kind === 'missing') {
    return <MissingPane onRetry={() => void refresh()} busy={busy} />
  }
  if (view.kind === 'empty') {
    return <EmptyPane onSync={onSync} busy={busy} />
  }
  if (view.kind === 'syncing') {
    return <SyncingPane status={view.status} />
  }
  return <SyncedPane status={view.status} onSync={onSync} onForget={onForget} busy={busy} />
}

// ---------- Sub-panes ------------------------------------------------------

function ErrorPane({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded border border-t-accent-alt/40 bg-t-accent-alt/5 p-3 text-sm text-t-accent-alt">
      <p className="break-words">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 rounded border border-t-border bg-t-surface px-3 py-1.5 text-xs font-medium text-t-muted transition-colors hover:border-t-border-active hover:text-t-bright"
      >
        Retry
      </button>
    </div>
  )
}

function MissingPane({ onRetry, busy }: { onRetry: () => void; busy: boolean }) {
  return (
    <div className="space-y-3 text-sm text-t-muted">
      <p>
        Filesystem RAG is configured, but your user directory hasn't been
        provisioned yet. Ask your operator to create it, then click Retry.
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={busy}
        className="rounded border border-t-accent bg-t-accent/10 px-3 py-1.5 text-xs font-medium text-t-bright transition-colors hover:bg-t-accent/20 disabled:opacity-50"
      >
        Retry
      </button>
    </div>
  )
}

function EmptyPane({ onSync, busy }: { onSync: () => void; busy: boolean }) {
  return (
    <div className="space-y-3 text-sm text-t-muted">
      <p>
        The configured directory is reachable
        {/* anonymised — never reveal the path */}
        <span className="ml-1 text-t-accent">✓</span>
      </p>
      <p>
        No files indexed yet. Drop documents into the directory (your
        operator knows where) and click Sync now.
      </p>
      <button
        type="button"
        onClick={onSync}
        disabled={busy}
        className="rounded border border-t-accent bg-t-accent/10 px-3 py-1.5 text-xs font-medium text-t-bright transition-colors hover:bg-t-accent/20 disabled:opacity-50"
      >
        {busy ? 'Starting…' : 'Sync now'}
      </button>
    </div>
  )
}

function SyncingPane({ status }: { status: RagStatus }) {
  return (
    <div className="space-y-2 text-sm text-t-muted">
      <p className="flex items-center gap-2 text-t-bright">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-t-accent" />
        Indexing your files…
      </p>
      <p className="text-xs text-t-muted/80">
        Job {status.in_flight_job_id?.slice(0, 8)} — checking again in a few seconds.
      </p>
    </div>
  )
}

function SyncedPane({
  status,
  onSync,
  onForget,
  busy,
}: {
  status: RagStatus
  onSync: () => void
  onForget: () => void
  busy: boolean
}) {
  const count = status.filesystem_file_count ?? 0
  const walkTs = status.filesystem_last_walk_ts ?? null
  return (
    <div className="space-y-3 text-sm text-t-muted">
      <p>
        <span className="text-t-bright">{count.toLocaleString()}</span>{' '}
        file{count === 1 ? '' : 's'} indexed
        {walkTs && <> · last walk {formatRelative(walkTs)}</>}.
      </p>
      {status.last_error && (
        <p className="rounded border border-t-accent-alt/40 bg-t-accent-alt/5 p-2 text-xs text-t-accent-alt">
          Last error: {status.last_error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSync}
          disabled={busy}
          className="rounded border border-t-accent bg-t-accent/10 px-3 py-1.5 text-xs font-medium text-t-bright transition-colors hover:bg-t-accent/20 disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Sync now'}
        </button>
        <button
          type="button"
          onClick={onForget}
          disabled={busy}
          className="rounded border border-t-border bg-t-surface px-3 py-1.5 text-xs font-medium text-t-muted transition-colors hover:border-t-border-active hover:text-t-bright disabled:opacity-50"
        >
          Forget
        </button>
      </div>
    </div>
  )
}
