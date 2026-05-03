import { useEffect, useRef, useState } from 'react'
import { Pause, Play, Trash2 } from 'lucide-react'

export type LogSeverity = 'debug' | 'info' | 'warn' | 'error' | 'success'

export interface LogLine {
  id: string | number
  ts?: string | number | Date
  severity?: LogSeverity
  source?: string
  message: string
}

interface LogStreamProps {
  lines: LogLine[]
  title?: string
  height?: number | string
  maxLines?: number
  onClear?: () => void
  autoScroll?: boolean
  showControls?: boolean
  className?: string
}

const severityColor: Record<LogSeverity, string> = {
  debug: 'text-t-muted',
  info: 'text-t-info',
  warn: 'text-t-warning',
  error: 'text-t-error',
  success: 'text-t-accent-alt',
}

const severityLabel: Record<LogSeverity, string> = {
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
  success: 'OK ',
}

function formatTs(ts: LogLine['ts']): string {
  if (!ts) return '--:--:--'
  const d = ts instanceof Date ? ts : new Date(ts)
  if (Number.isNaN(d.getTime())) return String(ts)
  return d.toTimeString().slice(0, 8)
}

export function LogStream({
  lines,
  title = 'LOG STREAM',
  height = 320,
  maxLines = 500,
  onClear,
  autoScroll = true,
  showControls = true,
  className = '',
}: LogStreamProps) {
  const [paused, setPaused] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const visible = lines.slice(-maxLines)

  useEffect(() => {
    if (paused || !autoScroll) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [visible, paused, autoScroll])

  return (
    <div className={`t-card flex flex-col overflow-hidden ${className}`} style={{ height }}>
      {(title || showControls) && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-t-border bg-t-surface/50">
          <div className="flex items-center gap-2">
            <span
              className={`h-1.5 w-1.5 rounded-full ${paused ? 'bg-t-warning' : 'bg-t-accent-alt animate-pulse'}`}
            />
            <span className="font-display text-xs text-t-bright uppercase tracking-wider">
              {title}
            </span>
            <span className="text-[10px] text-t-muted font-terminal">
              {visible.length}/{lines.length}
            </span>
          </div>
          {showControls && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPaused((p) => !p)}
                className="p-1 rounded text-t-muted hover:text-t-bright hover:bg-t-hover transition-colors"
                aria-label={paused ? 'Resume' : 'Pause'}
              >
                {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
              </button>
              {onClear && (
                <button
                  type="button"
                  onClick={onClear}
                  className="p-1 rounded text-t-muted hover:text-t-error hover:bg-t-hover transition-colors"
                  aria-label="Clear log"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-2 font-terminal text-[12px] leading-[1.5]"
      >
        {visible.length === 0 ? (
          <div className="text-t-muted text-center mt-6">— no events —</div>
        ) : (
          visible.map((line) => {
            const sev = line.severity ?? 'info'
            return (
              <div key={line.id} className="flex gap-2 whitespace-pre-wrap break-all">
                <span className="text-t-muted shrink-0">{formatTs(line.ts)}</span>
                <span className={`shrink-0 ${severityColor[sev]}`}>{severityLabel[sev]}</span>
                {line.source && (
                  <span className="text-t-accent shrink-0">[{line.source}]</span>
                )}
                <span className="text-t-text">{line.message}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
