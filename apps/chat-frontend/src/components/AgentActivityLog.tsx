// LogStream-backed activity feed for Agent Mode. Lives in the drawer.
// Useful for diagnosing slow turns ("which step is hanging?") and for
// curious users who want to see what tools the agent is firing without
// expanding every chip in the thread.

import { LogStream } from './library/LogStream'
import { useHarnessSession } from '../lib/harness-session'

export function AgentActivityLog({ height = 220 }: { height?: number | string }) {
  const { activityLog, clearActivityLog } = useHarnessSession()
  return (
    <LogStream
      title="Activity"
      lines={activityLog}
      height={height}
      onClear={clearActivityLog}
      autoScroll
    />
  )
}
