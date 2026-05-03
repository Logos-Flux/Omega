// HarnessTransport — a `ChatTransport` (from the AI SDK) that streams
// over a WebSocket to a Pi-harness running inside a user's Sprite,
// instead of HTTP-streaming to the chat-api. Plugs into `useChatRuntime`
// in place of `AssistantChatTransport`, so Agent Mode reuses the entire
// assistant-ui surface (threads, citations, edit/regenerate, action bar).
//
// Wire format (harness side):
//   client -> { type: 'send', id, sessionId, content, provider, model }
//   harness -> { type: 'delta', id, text }
//             { type: 'tool', id, name, status: 'start'|'done', input?, output? }
//             { type: 'sources', id, sources: [{uri, title?}] }
//             { type: 'done', id, provider, model }
//             { type: 'error', id, message }
//
// Translation to UIMessageChunk (the AI SDK's chunk shape that
// `useChat` consumes; see node_modules/ai/dist/index.d.ts:2159):
//   delta            -> text-start (once per `id`) + text-delta
//   tool start       -> tool-input-start + tool-input-available (we get
//                       the full input up front, so we don't need to
//                       stream it; one chunk pair per call covers the
//                       "tool requested" UI state)
//   tool done        -> tool-output-available (collapses the chip)
//   sources          -> source-url, one chunk per source
//   done             -> text-end (if we opened a text part) + finish
//   error            -> error chunk (which becomes an Error on `useChat`)
//
// The transport doesn't connect at construction. It lazy-creates a
// session via the controller's /api/session/start on the first
// `sendMessages` call and reuses it for the rest of the transport's
// lifetime. Toggling Agent Mode off + on creates a fresh transport
// (App.tsx wires it via `useMemo([agentMode])`), so the lifecycle is
// "one transport == one harness session".

import type {
  ChatRequestOptions,
  ChatTransport,
  UIMessage,
  UIMessageChunk,
} from 'ai'

import {
  WS_RETRY_DELAYS_MS,
  summarizeToolInput,
  uploadDownloadUrl,
  type SessionStartResponse,
  type UploadInfo,
} from './harness-utils'

export interface ProviderSelection {
  provider: string
  model: string
}

export interface HarnessTransportOptions {
  /** Origin + base path prefix, e.g. `/chat`. Used to call /api/controller/api/session/start. */
  apiBase: string
  /**
   * Returns the live provider/tier selection from the ProviderBar. Called
   * once per outgoing message so toggling provider doesn't need to
   * recreate the transport.
   */
  getProviderSelection: () => ProviderSelection
}

interface ActiveSession {
  sessionId: string
  token: string
  container: SessionStartResponse['container']
  ws: WebSocket
}

/**
 * Coarse activity phases the UI surfaces while a turn or session
 * lifecycle is in progress. Designed so the user always sees *some*
 * status during the gap between hitting Send and the first text-delta —
 * cold sprites can take 5–30s to warm up, and that gap was previously
 * indistinguishable from "frozen".
 *
 *   idle           — no activity; ready to receive a send
 *   starting       — POST /api/session/start, waiting on controller
 *   connecting     — WS dialing the sprite (with cold-start retry backoff)
 *   warming        — WS open, but the sprite is still booting / harness
 *                    hasn't acked our first frame yet
 *   thinking       — frame sent, no text-delta has arrived yet
 *   running-tool   — at least one tool call is in-flight (read_skill /
 *                    exec / web_search / etc.); label includes the tool name
 *   streaming      — text-delta chunks are flowing
 */
export type HarnessPhase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'connecting' }
  | { kind: 'warming' }
  | { kind: 'thinking' }
  | { kind: 'running-tool'; tool: string; hint?: string }
  | { kind: 'streaming' }

export type HarnessPhaseListener = (phase: HarnessPhase) => void

/**
 * In-flight assistant turn — one per `sendMessages` call, indexed by the
 * message id we hand to the harness. The transport keeps this around so
 * incoming WS frames can route to the right ReadableStream controller.
 */
interface InFlight {
  id: string
  controller: ReadableStreamDefaultController<UIMessageChunk>
  textStarted: boolean
  /** Maps harness tool `name` → toolCallId. The harness doesn't give us
   *  toolCallIds, so we mint one per (id, name) and reuse it on `done`. */
  toolCallIds: Map<string, string>
  /** Snapshot of upload filenames at the time this turn started. On
   *  `done` we fetch /uploads again, diff against this snapshot, and
   *  emit a `data-file` chunk for each new file so the UI can render a
   *  download card under the assistant reply. Promise lives in-flight
   *  so we don't block the send path on the upload fetch. */
  uploadsBeforePromise: Promise<Set<string>>
  /** Cleanup: remove this entry from the inflight map when the stream
   *  closes for any reason. */
  cleanup: () => void
}

/** Shape of the `data-file` chunk's payload (rendered by `<FileCard />`). */
export interface GeneratedFileData {
  filename: string
  size: number
  contentType?: string
  downloadUrl: string
}

export class HarnessTransport<UI_MESSAGE extends UIMessage = UIMessage>
  implements ChatTransport<UI_MESSAGE>
{
  private apiBase: string
  private getProviderSelection: () => ProviderSelection
  private session: ActiveSession | null = null
  private sessionPromise: Promise<ActiveSession> | null = null
  private destroyed = false
  private inFlight = new Map<string, InFlight>()

  private phase: HarnessPhase = { kind: 'idle' }
  private phaseListeners = new Set<HarnessPhaseListener>()

  constructor(options: HarnessTransportOptions) {
    this.apiBase = options.apiBase
    this.getProviderSelection = options.getProviderSelection
  }

  /** Current activity phase. */
  getPhase(): HarnessPhase {
    return this.phase
  }

  /** Subscribe to phase changes. Returns an unsubscribe function. */
  subscribePhase(listener: HarnessPhaseListener): () => void {
    this.phaseListeners.add(listener)
    return () => {
      this.phaseListeners.delete(listener)
    }
  }

  private setPhase(phase: HarnessPhase): void {
    // Skip no-op transitions to avoid waking subscribers needlessly.
    if (phasesEqual(this.phase, phase)) return
    this.phase = phase
    for (const l of this.phaseListeners) {
      try { l(phase) } catch { /* listener errors shouldn't kill the WS handler */ }
    }
  }

  /**
   * Public, read-only view of the active session for UI bits (uploads /
   * skills accordions in the drawer). Returns null until the first
   * `sendMessages` call kicks off the lazy session creation. Mutating
   * this object is unsupported — treat it as a snapshot.
   */
  getActiveSession(): {
    sessionId: string
    token: string
    container: SessionStartResponse['container']
  } | null {
    if (!this.session) return null
    return {
      sessionId: this.session.sessionId,
      token: this.session.token,
      container: this.session.container,
    }
  }

  /** Tear down: close the WS, fail any in-flight turns. Called by the
   *  parent component when toggling out of Agent Mode (a new transport
   *  will be constructed on toggle-on). */
  destroy(): void {
    this.destroyed = true
    for (const turn of this.inFlight.values()) {
      try {
        turn.controller.enqueue({ type: 'error', errorText: 'transport destroyed' })
        turn.controller.close()
      } catch {
        // already closed
      }
    }
    this.inFlight.clear()
    if (this.session?.ws) {
      try {
        this.session.ws.close()
      } catch {
        // ignore
      }
    }
    this.session = null
    this.sessionPromise = null
  }

  /** Cancel an in-flight turn. The harness doesn't expose a cancel frame
   *  yet, so we fail the local stream and wait for the (now-orphaned)
   *  remote response to drain into the dropped controller. TODO: add a
   *  `{type:'cancel', id}` frame to the harness protocol. */
  private cancelTurn(id: string, reason: string = 'aborted'): void {
    const turn = this.inFlight.get(id)
    if (!turn) return
    try {
      turn.controller.enqueue({ type: 'abort', reason })
      turn.controller.close()
    } catch {
      // already closed
    }
    turn.cleanup()
  }

  async sendMessages(
    options: {
      trigger: 'submit-message' | 'regenerate-message'
      chatId: string
      messageId: string | undefined
      messages: UI_MESSAGE[]
      abortSignal: AbortSignal | undefined
    } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk>> {
    if (this.destroyed) {
      throw new Error('HarnessTransport: transport has been destroyed')
    }

    // Pull the latest user message. For 'regenerate-message' the runtime
    // already truncated state.messages so the last entry is the user
    // message we should re-send. (See ai/src/ui/chat.ts line ~12970.)
    const lastUser = [...options.messages].reverse().find((m) => m.role === 'user')
    if (!lastUser) {
      throw new Error('HarnessTransport: no user message to send')
    }
    const content = extractText(lastUser)
    if (!content.trim()) {
      throw new Error('HarnessTransport: empty user message')
    }

    const session = await this.ensureSession()

    const turnId = randomUUID()
    const { provider, model } = this.getProviderSelection()

    // Build the ReadableStream the runtime will read. The transport
    // pumps WS frames into this stream's controller as they arrive.
    let inFlightRecord: InFlight | undefined
    const stream = new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        // The `start` chunk carries the assistant message's id so the
        // runtime sets its message.id correctly (see ai's
        // processUIMessageStream → case 'start'). We use the same id we
        // sent to the harness — that way the harness's `done`/`error`
        // frames are addressed to a stable id we can also surface in the
        // assistant message.
        controller.enqueue({ type: 'start', messageId: turnId })

        const cleanup = () => {
          this.inFlight.delete(turnId)
          if (abortListener) {
            options.abortSignal?.removeEventListener('abort', abortListener)
          }
        }

        // Snapshot the upload list NOW so we can diff against the
        // post-turn list to identify newly-generated files. Kicked off
        // in parallel with the send — we only await it on `done`.
        const uploadsBeforePromise = this.fetchUploadFilenames(session).catch(() => new Set<string>())

        inFlightRecord = {
          id: turnId,
          controller,
          textStarted: false,
          toolCallIds: new Map(),
          uploadsBeforePromise,
          cleanup,
        }
        this.inFlight.set(turnId, inFlightRecord)

        const abortListener = () => this.cancelTurn(turnId, 'user-abort')
        options.abortSignal?.addEventListener('abort', abortListener)

        // Send the harness frame. If the WS is closed, ensureSession()
        // already reconnected; if it's closing right at this instant,
        // that's a transient race — surface as an error chunk so the
        // user can retry.
        try {
          session.ws.send(
            JSON.stringify({
              type: 'send',
              id: turnId,
              sessionId: session.sessionId,
              content,
              provider,
              model,
            }),
          )
          // Frame is on the wire; we're now waiting for the model's first
          // text-delta. The phase machine flips to `streaming` on the
          // first delta or `running-tool` on the first tool frame.
          this.setPhase({ kind: 'thinking' })
        } catch (e) {
          this.setPhase({ kind: 'idle' })
          controller.enqueue({
            type: 'error',
            errorText: `harness send failed: ${(e as Error).message}`,
          })
          controller.close()
          cleanup()
        }
      },
      cancel: () => {
        // The runtime aborted the stream (e.g. user hit Stop). Clean up
        // our bookkeeping; the cancelTurn path above already enqueued
        // the abort chunk if it came via abortSignal.
        inFlightRecord?.cleanup()
      },
    })

    return stream
  }

  /**
   * The harness has no resumable HTTP stream — each WS turn is its own
   * thing — so reconnection isn't supported. Returning null tells the
   * runtime "there's nothing to resume". The WS reconnection (across
   * cold-start drops) is handled internally by ensureSession().
   */
  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null
  }

  // ----------------------------------------------------------------- session

  private async ensureSession(): Promise<ActiveSession> {
    if (this.destroyed) throw new Error('transport destroyed')
    if (this.session && this.session.ws.readyState === WebSocket.OPEN) {
      return this.session
    }
    if (this.sessionPromise) return this.sessionPromise

    this.sessionPromise = this.openSession()
      .then((s) => {
        this.session = s
        this.sessionPromise = null
        return s
      })
      .catch((e) => {
        this.sessionPromise = null
        throw e
      })
    return this.sessionPromise
  }

  private async openSession(): Promise<ActiveSession> {
    // TODO(phase-1.1): switch to /api/session/start once the user has been
    // provisioned per-user by the controller via the active ComputeProvider.
    // For now /demo returns the shared sprite and is the only working path.
    this.setPhase({ kind: 'starting' })
    const res = await fetch(`${this.apiBase}/api/controller/api/session/start`, {
      method: 'POST',
      credentials: 'include',
    })
    if (!res.ok) {
      this.setPhase({ kind: 'idle' })
      throw new Error(`controller /api/session/start: ${res.status} ${await res.text()}`)
    }
    const data = (await res.json()) as SessionStartResponse

    const wsUrl =
      data.container.url.replace(/^https?:/, 'wss:') +
      `/ws?token=${encodeURIComponent(data.token)}`

    this.setPhase({ kind: 'connecting' })
    const ws = await this.openWsWithRetry(wsUrl)

    const session: ActiveSession = {
      sessionId: data.sessionId,
      token: data.token,
      container: data.container,
      ws,
    }

    // Wire the message handler. We bind to `this` via arrow.
    // onWsMessage is async (it fetches uploads on `done`), but we don't
    // need to await it — fire-and-forget per WS message is correct.
    ws.addEventListener('message', (e) => { void this.onWsMessage(e) })
    ws.addEventListener('close', () => this.onWsClose())
    return session
  }

  /** Fetch the current upload list as a set of filenames. Used both
   *  for the pre-turn snapshot and the post-turn diff. */
  private async fetchUploadFilenames(session: ActiveSession): Promise<Set<string>> {
    const r = await fetch(
      `${session.container.url}/uploads/${encodeURIComponent(session.sessionId)}`,
      { headers: { authorization: `Bearer ${session.token}` } },
    )
    if (!r.ok) return new Set()
    const data = (await r.json()) as { uploads?: UploadInfo[] }
    return new Set((data.uploads ?? []).map((u) => u.filename))
  }

  /** Fetch the current upload list as full UploadInfo records. Used on
   *  `done` to enrich the data-file chunks with size + contentType. */
  private async fetchUploadDetails(session: ActiveSession): Promise<UploadInfo[]> {
    const r = await fetch(
      `${session.container.url}/uploads/${encodeURIComponent(session.sessionId)}`,
      { headers: { authorization: `Bearer ${session.token}` } },
    )
    if (!r.ok) return []
    const data = (await r.json()) as { uploads?: UploadInfo[] }
    return data.uploads ?? []
  }

  private openWsWithRetry(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const attempt = (n: number) => {
        const ws = new WebSocket(url)
        let opened = false
        ws.addEventListener('open', () => {
          opened = true
          resolve(ws)
        })
        ws.addEventListener('close', () => {
          if (opened) return // resolved already; subsequent close is post-open
          if (n < WS_RETRY_DELAYS_MS.length) {
            setTimeout(() => attempt(n + 1), WS_RETRY_DELAYS_MS[n]!)
          } else {
            reject(
              new Error(
                `harness WS failed after ${WS_RETRY_DELAYS_MS.length + 1} attempts`,
              ),
            )
          }
        })
        ws.addEventListener('error', () => {
          // Browsers fire `error` then `close`; the close handler owns
          // retry/rejection. Nothing to do here.
        })
      }
      attempt(0)
    })
  }

  private onWsClose(): void {
    if (this.destroyed) return
    // The harness was restarted (typical during a deploy). Fail any
    // in-flight turns so the UI doesn't hang. The next sendMessages
    // call will lazily re-open via ensureSession().
    for (const turn of this.inFlight.values()) {
      try {
        turn.controller.enqueue({
          type: 'error',
          errorText: 'harness connection closed',
        })
        turn.controller.close()
      } catch {
        // already closed
      }
      turn.cleanup()
    }
    this.session = null
  }

  // ----------------------------------------------------------------- ws frames

  private async onWsMessage(e: MessageEvent): Promise<void> {
    let frame: WireFrame | null = null
    try {
      const raw =
        typeof e.data === 'string'
          ? e.data
          : new TextDecoder().decode(e.data as ArrayBuffer)
      frame = JSON.parse(raw) as WireFrame
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return

    const id = (frame as { id?: string }).id
    if (!id) return
    const turn = this.inFlight.get(id)
    if (!turn) return

    switch (frame.type) {
      case 'delta': {
        const f = frame as Extract<WireFrame, { type: 'delta' }>
        if (typeof f.text !== 'string') return
        if (!turn.textStarted) {
          turn.controller.enqueue({ type: 'text-start', id: turn.id })
          turn.textStarted = true
        }
        turn.controller.enqueue({
          type: 'text-delta',
          id: turn.id,
          delta: f.text,
        })
        this.setPhase({ kind: 'streaming' })
        break
      }
      case 'tool': {
        const f = frame as Extract<WireFrame, { type: 'tool' }>
        if (!f.name || !f.status) return
        // Mint a stable toolCallId per (turn, tool name + JSON-input).
        // The harness doesn't give us a toolCallId, so we synthesize one
        // and reuse it for the matching `done` frame. Including
        // stringified input in the key handles the case where the same
        // tool is called twice in one turn — they'll get distinct ids.
        const callKey = `${f.name}::${JSON.stringify(f.input ?? null)}`
        let toolCallId: string
        if (f.status === 'start') {
          toolCallId = randomUUID()
          turn.toolCallIds.set(callKey, toolCallId)
          turn.controller.enqueue({
            type: 'tool-input-start',
            toolCallId,
            toolName: f.name,
            dynamic: true,
          })
          turn.controller.enqueue({
            type: 'tool-input-available',
            toolCallId,
            toolName: f.name,
            input: f.input ?? {},
            dynamic: true,
          })
          // Surface the tool call in the activity indicator so the user
          // sees "running pdftotext…" instead of a frozen "Thinking".
          this.setPhase({
            kind: 'running-tool',
            tool: f.name,
            hint: summarizeToolInput(f.name, f.input),
          })
        } else {
          // 'done'. Look up the existing toolCallId; if absent, mint one
          // (defensive — shouldn't happen since the harness always emits
          // start before done) and emit start/input/output as a unit.
          const existing = turn.toolCallIds.get(callKey)
          toolCallId = existing ?? randomUUID()
          if (!existing) {
            turn.controller.enqueue({
              type: 'tool-input-start',
              toolCallId,
              toolName: f.name,
              dynamic: true,
            })
            turn.controller.enqueue({
              type: 'tool-input-available',
              toolCallId,
              toolName: f.name,
              input: f.input ?? {},
              dynamic: true,
            })
          }
          turn.controller.enqueue({
            type: 'tool-output-available',
            toolCallId,
            output: f.output ?? null,
            dynamic: true,
          })
          turn.toolCallIds.delete(callKey)
          // Tool finished. Drop back to thinking — there may be more
          // tools in the same turn, or text might start streaming next.
          this.setPhase({ kind: 'thinking' })
        }
        break
      }
      case 'sources': {
        const f = frame as Extract<WireFrame, { type: 'sources' }>
        if (!Array.isArray(f.sources)) return
        for (const s of f.sources) {
          if (!s?.uri) continue
          turn.controller.enqueue({
            type: 'source-url',
            // sourceId must be unique per source-url within a message;
            // the URL is a reasonable default since it's already unique
            // in the visible chip list.
            sourceId: s.uri,
            url: s.uri,
            ...(s.title ? { title: s.title } : {}),
          })
        }
        break
      }
      case 'done': {
        if (turn.textStarted) {
          turn.controller.enqueue({ type: 'text-end', id: turn.id })
        }

        // Diff post-turn uploads against the pre-turn snapshot. Any
        // file that didn't exist when this turn started AND exists
        // now was generated by the agent — emit one `data-file`
        // chunk per so the UI can render a download card under the
        // assistant message. We do this BEFORE `finish` so the data
        // parts attach to the right message.
        try {
          const session = this.session
          if (session) {
            const before = await turn.uploadsBeforePromise
            const after = await this.fetchUploadDetails(session)
            for (const f of after) {
              if (before.has(f.filename)) continue
              const data: GeneratedFileData = {
                filename: f.filename,
                size: f.size,
                ...(f.contentType ? { contentType: f.contentType } : {}),
                downloadUrl: uploadDownloadUrl(
                  session.container.url,
                  session.sessionId,
                  f.filename,
                  session.token,
                ),
              }
              turn.controller.enqueue({
                type: 'data-file',
                data,
              } as UIMessageChunk)
            }
          }
        } catch (err) {
          console.error('[harness-transport] uploads diff failed:', err)
        }

        turn.controller.enqueue({ type: 'finish' })
        turn.controller.close()
        turn.cleanup()
        if (this.inFlight.size === 0) this.setPhase({ kind: 'idle' })
        break
      }
      case 'error': {
        const f = frame as Extract<WireFrame, { type: 'error' }>
        turn.controller.enqueue({
          type: 'error',
          errorText: f.message ?? 'unknown harness error',
        })
        turn.controller.close()
        turn.cleanup()
        break
      }
    }
  }
}

// ----------------------------------------------------------------- helpers

type WireFrame =
  | { type: 'delta'; id: string; text: string }
  | {
      type: 'tool'
      id: string
      name: string
      status: 'start' | 'done'
      input?: unknown
      output?: unknown
    }
  | { type: 'sources'; id: string; sources: { uri: string; title?: string }[] }
  | { type: 'done'; id: string }
  | { type: 'error'; id: string; message: string }

function randomUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback (shouldn't trigger in any modern browser, but TS-safe).
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * Pull plain text out of a UIMessage. The runtime hands us a structured
 * UIMessage with a `parts` array; the harness's `send` frame expects a
 * flat string. Concatenate all text + reasoning parts.
 */
function extractText(message: UIMessage): string {
  const parts = (message.parts ?? []) as Array<{ type: string; text?: string }>
  const out: string[] = []
  for (const p of parts) {
    if ((p.type === 'text' || p.type === 'reasoning') && typeof p.text === 'string') {
      out.push(p.text)
    }
  }
  return out.join('\n')
}

function phasesEqual(a: HarnessPhase, b: HarnessPhase): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'running-tool' && b.kind === 'running-tool') {
    return a.tool === b.tool && a.hint === b.hint
  }
  return true
}
