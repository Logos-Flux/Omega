// RAG source card — the Connectors-section card that adapts to whichever
// ingest source the deploy has wired up. Replaces v0.5.x's drive-only
// <DriveConnectCard>.
//
// Resolution order on mount:
//   1. /api/rag/enabled  → if false, render nothing (OSS deployments without
//                          a RAG backend stay clean).
//   2. /api/rag/source   → mode + features bundle. Picks which body pane to
//                          dispatch to, and supplies the header text.
//   3. body pane         → <DriveConnectPane> or <FilesystemPane> takes over,
//                          including the per-mode /status state machine.
//
// The wrapping <section> + header live here so all the layout/typography
// is in one place; sub-panes own only their state machine + buttons.

import { useEffect, useState } from 'react'
import { getRagEnabled, getRagSource, type RagSourceInfo } from '../lib/rag-api'
import { DriveConnectPane } from './DriveConnectPane'
import { FilesystemPane } from './FilesystemPane'

type Boot =
  | { kind: 'loading' }
  | { kind: 'disabled' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'ready'; info: RagSourceInfo }

export function RAGSourceCard() {
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const enabled = await getRagEnabled()
      if (cancelled) return
      if (!enabled) {
        setBoot({ kind: 'disabled' })
        return
      }
      try {
        const info = await getRagSource()
        if (cancelled) return
        setBoot({ kind: 'ready', info })
      } catch (err) {
        if (cancelled) return
        // /source is ungated — a failure here means the controller is
        // unreachable or running an older build that hasn't deployed
        // the route yet. Show the user something rather than nothing
        // so they're not confused by a missing card.
        setBoot({ kind: 'unavailable', message: (err as Error).message })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (boot.kind === 'loading' || boot.kind === 'disabled') return null

  if (boot.kind === 'unavailable') {
    return (
      <section className="rounded border border-t-border bg-t-surface p-5">
        <header className="mb-3">
          <h2 className="font-display text-lg text-t-bright">RAG content</h2>
        </header>
        <div className="rounded border border-t-accent-alt/40 bg-t-accent-alt/5 p-3 text-sm text-t-accent-alt">
          <p className="break-words">
            Couldn't reach the RAG service to determine source mode: {boot.message}
          </p>
        </div>
      </section>
    )
  }

  const { mode, features } = boot.info
  return (
    <section className="rounded border border-t-border bg-t-surface p-5">
      <header className="mb-3">
        <h2 className="font-display text-lg text-t-bright">{titleFor(mode)}</h2>
        <p className="mt-1 text-sm text-t-muted">{descriptionFor(mode, features)}</p>
      </header>
      {mode === 'drive' ? <DriveConnectPane /> : <FilesystemPane />}
    </section>
  )
}

function titleFor(mode: RagSourceInfo['mode']): string {
  if (mode === 'drive') return 'Google Drive'
  return 'RAG content'
}

function descriptionFor(
  mode: RagSourceInfo['mode'],
  features: RagSourceInfo['features'],
): string {
  if (mode === 'drive') {
    return features.shared_folder
      ? 'Index your my-ai/ Drive folder plus the shared knowledge base your operator has configured, so the assistant can cite from it.'
      : 'Index your my-ai/ Drive folder so the assistant can cite from it.'
  }
  // Filesystem mode. Don't reveal where the directory is — the value
  // may carry internal infrastructure details.
  return 'Files dropped into the operator-configured directory get indexed for the assistant to cite from.'
}
