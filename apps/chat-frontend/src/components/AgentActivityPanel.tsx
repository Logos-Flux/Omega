// Right-side Activity feed for Agent Mode. Just the LogStream — session
// metadata + uploads + skills already live in the left drawer. Has a
// collapse toggle so it can shrink to a thin vertical strip when the
// user wants more horizontal room for the chat.
//
// Persists open/collapsed state across reloads in localStorage so the
// user's preference sticks. Default is open in agent mode.

import { useEffect, useState } from 'react'
import { Activity as ActivityIcon, ChevronRight, ChevronLeft, Trash2 } from 'lucide-react'
import { useHarnessSession } from '../lib/harness-session'
import { LogStream } from './library/LogStream'
import { cn } from '../lib/cn'
import { readWithLegacyKey } from '../lib/storage'

const COLLAPSED_KEY = 'omega.chat.activityPanelCollapsed'
const LEGACY_COLLAPSED_KEY = '52l.chat.activityPanelCollapsed'

export function AgentActivityPanel() {
  const { activityLog, clearActivityLog } = useHarnessSession()
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return readWithLegacyKey(window.localStorage, COLLAPSED_KEY, LEGACY_COLLAPSED_KEY) === '1'
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  if (collapsed) {
    return (
      <aside className="hidden w-8 shrink-0 flex-col items-center border-l border-t-border bg-t-surface md:flex">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Show activity panel"
          className="flex h-12 w-full items-center justify-center text-t-muted transition-colors hover:bg-t-hover hover:text-t-bright"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="mt-1 flex flex-col items-center gap-1 px-1 py-2 text-t-muted">
          <ActivityIcon className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="font-display text-[9px] uppercase tracking-[0.2em]" style={{ writingMode: 'vertical-rl' }}>
            Activity
          </span>
          {activityLog.length > 0 && (
            <span className="font-terminal text-[10px] tabular-nums text-t-muted">
              {activityLog.length}
            </span>
          )}
        </div>
      </aside>
    )
  }

  return (
    <aside className="hidden w-80 shrink-0 flex-col border-l border-t-border bg-t-surface md:flex">
      <header className="flex items-center justify-between border-b border-t-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <ActivityIcon className="h-3.5 w-3.5 text-t-muted" aria-hidden="true" />
          <span className="font-display text-[10px] uppercase tracking-[0.2em] text-t-bright">
            Activity
          </span>
          <span className="font-terminal text-[10px] tabular-nums text-t-muted">
            {activityLog.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {activityLog.length > 0 && (
            <button
              type="button"
              onClick={clearActivityLog}
              aria-label="Clear activity"
              className="grid h-6 w-6 place-items-center rounded text-t-muted transition-colors hover:bg-t-hover hover:text-t-error"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse activity panel"
            className={cn(
              'grid h-6 w-6 place-items-center rounded text-t-muted transition-colors',
              'hover:bg-t-hover hover:text-t-bright',
            )}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 p-2">
        <LogStream
          lines={activityLog}
          height="100%"
          showControls={false}
          autoScroll
        />
      </div>
    </aside>
  )
}
