// React-side glue for the agent-mode harness. The HarnessTransport
// owns the WS lifecycle; this module exposes session info to UI bits
// (uploads / skills accordions in the drawer) via context, and provides
// hooks that fetch the harness-side resources.
//
// Why context? The transport is stable across renders inside a single
// AgentMode-on session, but it lives inside <ChatPageInner>. The drawer
// is a sibling of the Thread, also inside the AppShell, so a small
// provider above both gives them a way to share session state without
// drilling props through assistant-ui's primitives.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { HarnessPhase, HarnessTransport } from './harness-transport'
import type { LogLine } from '../components/library/LogStream'
import {
  MAX_UPLOAD_BYTES,
  type SessionStartResponse,
  type SkillSummary,
  type UploadInfo,
  uploadDownloadUrl,
} from './harness-utils'

interface HarnessSessionState {
  sessionId: string
  token: string
  container: SessionStartResponse['container']
}

interface HarnessSessionContextValue {
  /** Null until the transport opens the first WS and we mirror it here. */
  session: HarnessSessionState | null
  /** Live transport activity phase. Drives the activity indicator UI so
   *  the user sees `Starting…` / `Connecting…` / `Thinking…` / etc.
   *  instead of a frozen-looking screen during the gap before the first
   *  text-delta. */
  phase: HarnessPhase
  /** Append-only activity log derived from phase transitions. Wired to
   *  the showcase library's `<LogStream />` for diagnostics. */
  activityLog: LogLine[]
  clearActivityLog: () => void
  /** Reactive uploads list. Refreshed automatically on connect + after
   *  uploads. */
  uploads: UploadInfo[]
  refreshUploads: () => Promise<UploadInfo[]>
  uploadFiles: (files: FileList | File[]) => Promise<void>
  uploadingCount: number
  /** Reactive skills list. */
  skills: SkillSummary[]
  /** Build a download URL for a given filename in the active session. */
  downloadUrlFor: (filename: string) => string | undefined
  /** Surface upload errors for the UI to render. */
  uploadError: string | null
  clearUploadError: () => void
}

const HarnessSessionContext = createContext<HarnessSessionContextValue | null>(null)

/**
 * Pokes the transport for session info and keeps a copy in context.
 *
 * The transport is the source of truth (and lazy-creates the session on
 * first send), but the UI accordions need to know "are we connected
 * yet?" without poking the runtime. So this provider polls the
 * transport on a short interval until session is ready, then stops.
 *
 * If the transport prop is null (Agent Mode is off), the context value
 * is empty/no-op and consumers render nothing.
 */
export function HarnessSessionProvider({
  transport,
  children,
}: {
  transport: HarnessTransport | null
  children: React.ReactNode
}) {
  const [session, setSession] = useState<HarnessSessionState | null>(null)
  const [uploads, setUploads] = useState<UploadInfo[]>([])
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [uploadingCount, setUploadingCount] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [phase, setPhase] = useState<HarnessPhase>(
    () => transport?.getPhase() ?? { kind: 'idle' },
  )
  const [activityLog, setActivityLog] = useState<LogLine[]>([])
  const logIdRef = useRef(0)
  const clearActivityLog = useCallback(() => setActivityLog([]), [])

  // Subscribe (push) to phase transitions on the transport. Each
  // transition appends a LogLine so the LogStream view shows a
  // diagnostic feed of "what the agent is doing right now".
  useEffect(() => {
    if (!transport) {
      setPhase({ kind: 'idle' })
      return
    }
    setPhase(transport.getPhase())
    const unsubscribe = transport.subscribePhase((next) => {
      setPhase(next)
      const entry = phaseToLogLine(next, ++logIdRef.current)
      if (entry) setActivityLog((prev) => [...prev, entry])
    })
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport])

  // Poll the transport for session info. The transport exposes the
  // session via a getter we add below. We poll because the transport
  // creates the session lazily on the first sendMessages call and
  // there's no event we subscribe to today.
  useEffect(() => {
    if (!transport) {
      setSession(null)
      return
    }
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      const s = transport.getActiveSession()
      if (s && (!session || s.sessionId !== session.sessionId)) {
        setSession(s)
      } else if (!s && session) {
        setSession(null)
      }
    }
    tick()
    const handle = window.setInterval(tick, 1000)
    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
    // Intentionally re-run only when the transport instance swaps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport])

  const refreshUploads = useCallback(async (): Promise<UploadInfo[]> => {
    if (!session) return []
    try {
      const r = await fetch(
        `${session.container.url}/uploads/${encodeURIComponent(session.sessionId)}`,
        { headers: { authorization: `Bearer ${session.token}` } },
      )
      if (!r.ok) return []
      const data = (await r.json()) as { uploads?: UploadInfo[] }
      const list = data.uploads ?? []
      setUploads(list)
      return list
    } catch {
      return []
    }
  }, [session])

  // Refresh on (re)connect. Skills come from /skills, uploads from
  // /uploads/<sessionId>. Log loudly when either fails so we don't end
  // up with `count=0` for hours wondering whether it's a token
  // problem, a network problem, or a parse problem.
  useEffect(() => {
    if (!session) return
    void refreshUploads()
    let cancelled = false
    const url = `${session.container.url.replace(/\/$/, '')}/skills`
    fetch(url, { headers: { authorization: `Bearer ${session.token}` } })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.text().catch(() => '')
          console.error(`[harness/skills] ${r.status} from ${url}:`, body.slice(0, 200))
          return null
        }
        return r.json() as Promise<{ skills?: SkillSummary[] }>
      })
      .then((data) => {
        if (cancelled) return
        if (!data) return
        if (!Array.isArray(data.skills)) {
          console.error('[harness/skills] response missing `skills` array:', data)
          return
        }
        console.info(`[harness/skills] loaded ${data.skills.length} skill(s)`)
        setSkills(data.skills)
      })
      .catch((err) => {
        console.error(`[harness/skills] fetch failed for ${url}:`, err)
      })
    return () => {
      cancelled = true
    }
  }, [session, refreshUploads])

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      if (!session) return
      const arr = Array.from(files)
      setUploadingCount((n) => n + arr.length)
      try {
        for (const file of arr) {
          if (file.size > MAX_UPLOAD_BYTES) {
            setUploadError(
              `${file.name}: too large (${file.size} > ${MAX_UPLOAD_BYTES} bytes)`,
            )
            continue
          }
          const fd = new FormData()
          fd.set('sessionId', session.sessionId)
          fd.set('file', file)
          const r = await fetch(`${session.container.url}/uploads`, {
            method: 'POST',
            body: fd,
            headers: { authorization: `Bearer ${session.token}` },
          })
          if (!r.ok) {
            const txt = await r.text().catch(() => '')
            setUploadError(`upload failed: ${r.status} ${txt}`)
          }
        }
        await refreshUploads()
      } finally {
        setUploadingCount((n) => Math.max(0, n - arr.length))
      }
    },
    [session, refreshUploads],
  )

  const downloadUrlFor = useCallback(
    (filename: string) =>
      session
        ? uploadDownloadUrl(session.container.url, session.sessionId, filename, session.token)
        : undefined,
    [session],
  )

  const clearUploadError = useCallback(() => setUploadError(null), [])

  const value = useMemo<HarnessSessionContextValue>(
    () => ({
      session,
      phase,
      activityLog,
      clearActivityLog,
      uploads,
      refreshUploads,
      uploadFiles,
      uploadingCount,
      skills,
      downloadUrlFor,
      uploadError,
      clearUploadError,
    }),
    [
      session,
      phase,
      activityLog,
      clearActivityLog,
      uploads,
      refreshUploads,
      uploadFiles,
      uploadingCount,
      skills,
      downloadUrlFor,
      uploadError,
      clearUploadError,
    ],
  )

  return (
    <HarnessSessionContext.Provider value={value}>{children}</HarnessSessionContext.Provider>
  )
}

/** Returns the harness session context. Returns a no-op shape if used
 *  outside <HarnessSessionProvider> so call sites don't need to
 *  conditionally render based on Agent Mode. */
export function useHarnessSession(): HarnessSessionContextValue {
  const ctx = useContext(HarnessSessionContext)
  if (ctx) return ctx
  return EMPTY_HARNESS_SESSION
}

const EMPTY_HARNESS_SESSION: HarnessSessionContextValue = {
  session: null,
  phase: { kind: 'idle' },
  activityLog: [],
  clearActivityLog: () => {},
  uploads: [],
  refreshUploads: async () => [],
  uploadFiles: async () => {},
  uploadingCount: 0,
  skills: [],
  downloadUrlFor: () => undefined,
  uploadError: null,
  clearUploadError: () => {},
}

function phaseToLogLine(phase: HarnessPhase, id: number): LogLine | null {
  const ts = new Date()
  switch (phase.kind) {
    case 'idle':
      return { id, ts, severity: 'success', source: 'harness', message: 'idle — ready' }
    case 'starting':
      return { id, ts, severity: 'info', source: 'controller', message: 'starting session…' }
    case 'connecting':
      return { id, ts, severity: 'info', source: 'sprite', message: 'opening WebSocket…' }
    case 'warming':
      return { id, ts, severity: 'info', source: 'sprite', message: 'warming up…' }
    case 'thinking':
      return { id, ts, severity: 'info', source: 'agent', message: 'thinking…' }
    case 'running-tool':
      return {
        id,
        ts,
        severity: 'info',
        source: 'tool',
        message: phase.hint ? `${phase.tool} · ${phase.hint}` : phase.tool,
      }
    case 'streaming':
      return { id, ts, severity: 'success', source: 'agent', message: 'streaming response' }
    default:
      return null
  }
}
