// Connect-Drive UX. Lives in Settings → Connectors. Self-gates on
// /api/rag/enabled, so OSS deployments without a RAG backend hide the
// card entirely (no broken-looking "rag-api unreachable" placeholder).
//
// State machine:
//
//   loading-flag       → spinner while we wait on /api/rag/enabled
//   disabled           → nothing rendered (operator hasn't wired RAG)
//   loading-status     → spinner under the card while we fetch /status
//   error              → 4xx/5xx from /status; show + Retry
//   needs-folder       → my_ai_folder_status === 'missing'; instructions
//                        to create the folder + Retry
//   never-synced       → no last_synced_at and no in_flight_job; "Sync"
//   syncing            → in_flight_job_id set; spinner + polling
//   synced             → file_count + relative time + "Sync now" + "Forget"
//
// The polling loop runs every 3s while `in_flight_job_id` is non-null;
// stops on the first status response with it cleared (or the next
// failure). Polling cancels on unmount.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  forgetRag,
  getRagEnabled,
  getRagStatus,
  triggerRagSync,
  type RagStatus,
} from '../lib/rag-api'

const POLL_INTERVAL_MS = 3000

type ViewState =
  | { kind: 'loading-flag' }
  | { kind: 'disabled' }
  | { kind: 'loading-status' }
  | { kind: 'error'; message: string }
  | { kind: 'needs-folder'; status: RagStatus }
  | { kind: 'never-synced'; status: RagStatus }
  | { kind: 'syncing'; status: RagStatus }
  | { kind: 'synced'; status: RagStatus }

function deriveView(status: RagStatus): Exclude<ViewState, { kind: 'loading-flag' | 'disabled' | 'loading-status' | 'error' }> {
  if (status.my_ai_folder_status === 'missing') return { kind: 'needs-folder', status }
  if (status.in_flight_job_id) return { kind: 'syncing', status }
  if (!status.last_synced_at) return { kind: 'never-synced', status }
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

export function DriveConnectCard() {
  const [view, setView] = useState<ViewState>({ kind: 'loading-flag' })
  const [busy, setBusy] = useState(false)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelled = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const status = await getRagStatus()
      if (cancelled.current) return
      setView(deriveView(status))
      // Schedule another poll while a job is in flight.
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
    void (async () => {
      const enabled = await getRagEnabled()
      if (cancelled.current) return
      if (!enabled) {
        setView({ kind: 'disabled' })
        return
      }
      setView({ kind: 'loading-status' })
      await refresh()
    })()
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
    if (!window.confirm('Forget all indexed Drive content for your account? This drops every file the rag service has cataloged for you. The files in Drive itself are untouched.')) return
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

  if (view.kind === 'disabled') return null
  if (view.kind === 'loading-flag') return null

  return (
    <section className="rounded border border-t-border bg-t-surface p-5">
      <header className="mb-3">
        <h2 className="font-display text-lg text-t-bright">Google Drive</h2>
        <p className="mt-1 text-sm text-t-muted">
          Index your <code className="rounded bg-t-deep px-1 py-0.5 font-mono text-xs">my-ai/</code> Drive folder
          (and any shared knowledge base your operator has configured) so the
          assistant can cite from it.
        </p>
      </header>

      {view.kind === 'loading-status' && (
        <p className="text-sm text-t-muted">Loading…</p>
      )}

      {view.kind === 'error' && (
        <ErrorPane message={view.message} onRetry={() => void refresh()} />
      )}

      {view.kind === 'needs-folder' && (
        <NeedsFolderPane onRetry={() => void refresh()} busy={busy} />
      )}

      {view.kind === 'never-synced' && (
        <NeverSyncedPane onSync={onSync} busy={busy} />
      )}

      {view.kind === 'syncing' && (
        <SyncingPane status={view.status} />
      )}

      {view.kind === 'synced' && (
        <SyncedPane status={view.status} onSync={onSync} onForget={onForget} busy={busy} />
      )}
    </section>
  )
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

function NeedsFolderPane({ onRetry, busy }: { onRetry: () => void; busy: boolean }) {
  return (
    <div className="space-y-3 text-sm text-t-muted">
      <p>
        We couldn't find a folder named <code className="rounded bg-t-deep px-1 py-0.5 font-mono text-xs">my-ai</code> in your Drive root.
      </p>
      <p>
        Open <a className="text-t-accent underline" href="https://drive.google.com/" target="_blank" rel="noreferrer noopener">Google Drive</a>, create a folder called <code className="rounded bg-t-deep px-1 py-0.5 font-mono text-xs">my-ai</code>, drop the files you want indexed into it, then click Retry.
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

function NeverSyncedPane({ onSync, busy }: { onSync: () => void; busy: boolean }) {
  return (
    <div className="space-y-3 text-sm text-t-muted">
      <p>You haven't synced your Drive yet.</p>
      <button
        type="button"
        onClick={onSync}
        disabled={busy}
        className="rounded border border-t-accent bg-t-accent/10 px-3 py-1.5 text-xs font-medium text-t-bright transition-colors hover:bg-t-accent/20 disabled:opacity-50"
      >
        {busy ? 'Starting…' : 'Sync Drive'}
      </button>
    </div>
  )
}

function SyncingPane({ status }: { status: RagStatus }) {
  return (
    <div className="space-y-2 text-sm text-t-muted">
      <p className="flex items-center gap-2 text-t-bright">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-t-accent" />
        Indexing your Drive…
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
  return (
    <div className="space-y-3 text-sm text-t-muted">
      <p>
        <span className="text-t-bright">{status.file_count.toLocaleString()}</span>{' '}
        file{status.file_count === 1 ? '' : 's'} indexed
        {status.last_synced_at && <> · last synced {formatRelative(status.last_synced_at)}</>}.
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
