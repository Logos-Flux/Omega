// Compact phase indicator that lives above the Thread when Agent Mode
// is on. The whole point: between hitting Send and the first text-delta
// the chat used to look frozen. This bar makes it obvious the system is
// working its way through real phases (controller → sprite → harness →
// model) and lets the user diagnose slow steps instead of guessing.
//
// Hidden when phase is `idle` and there's no in-flight session — the
// chat-api runtime doesn't need this and we don't want a stale "ready"
// banner cluttering the surface.

import { useHarnessSession } from '../lib/harness-session'
import type { HarnessPhase } from '../lib/harness-transport'

export function AgentActivityIndicator() {
  const { phase, session } = useHarnessSession()

  // Hide when nothing's happening AND no session yet (first paint).
  if (phase.kind === 'idle' && !session) return null

  return (
    <div className="flex items-center gap-2 border-b border-t-border bg-t-surface/60 px-4 py-1.5">
      <PhaseDot phase={phase} />
      <span className="font-display text-[10px] uppercase tracking-[0.18em] text-t-bright">
        {phaseTitle(phase)}
      </span>
      {phaseDetail(phase) && (
        <span className="font-terminal text-[11px] text-t-muted truncate">
          {phaseDetail(phase)}
        </span>
      )}
    </div>
  )
}

function PhaseDot({ phase }: { phase: HarnessPhase }) {
  const cls =
    phase.kind === 'idle'
      ? 'bg-t-success'
      : phase.kind === 'streaming'
        ? 'bg-t-accent-alt animate-pulse'
        : phase.kind === 'running-tool'
          ? 'bg-t-info animate-pulse'
          : 'bg-t-warning animate-pulse'
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} aria-hidden />
}

function phaseTitle(phase: HarnessPhase): string {
  switch (phase.kind) {
    case 'idle':
      return 'Ready'
    case 'starting':
      return 'Starting session'
    case 'connecting':
      return 'Connecting to sprite'
    case 'warming':
      return 'Warming up'
    case 'thinking':
      return 'Thinking'
    case 'running-tool':
      return `Running ${phase.tool}`
    case 'streaming':
      return 'Streaming response'
  }
}

function phaseDetail(phase: HarnessPhase): string | null {
  if (phase.kind === 'running-tool' && phase.hint) return phase.hint
  return null
}
