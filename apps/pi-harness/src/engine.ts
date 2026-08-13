// Engine — consumes a RequestPayload, runs streamText, emits chunks
// back over the WebSocket. Renamed from chat.ts::handleSend; the
// streamText loop body is unchanged.
//
// Wrapped by middleware (KillSwitch, TokenBudgeter, RefusalGuard,
// ConfirmationGate, AuditLogger). All five are no-op identity
// passthroughs in Phase I; real implementations land in Phase IX. They
// compose in the fixed order specified in AGENT_ARCHITECTURE.md L800:
//
//   KillSwitch → TokenBudgeter → RefusalGuard → ConfirmationGate
//                → AuditLogger → engine
//
// Composition is left-to-right: the outermost middleware runs first
// and gets to short-circuit before deeper layers see the payload.

import { streamText } from 'ai'
import { PROVIDERS } from './providers'
import { PromptAssembler } from './assembler'
import { dispatchUser } from './dispatcher'
import { appendConversation } from './memory'
import type { IncomingSend, Outgoing, RequestPayload } from './types'

// ---
// Middleware contract. Each middleware wraps a `next` runner; it can
// inspect/mutate the payload, decide to short-circuit (e.g. emit an
// error and not call next), or just pass through. Phase I stubs all
// five as pass-throughs.
// ---

interface RunContext {
  msg: IncomingSend
  emit: (out: Outgoing) => void
  // Optional abort signal — set when the WS handler registered an
  // AbortController for this turn (X.C.1). Forwarded to streamText so
  // a `cancel` frame from the client tears down the inference loop.
  signal?: AbortSignal
}

type EngineRunner = (
  payload: RequestPayload,
  ctx: RunContext,
) => Promise<void>

type Middleware = (next: EngineRunner) => EngineRunner

// IX.A.5 — Per-user agent-loop counter, max depth/chain caps.
const KillSwitch: Middleware = (next) => async (payload, ctx) => {
  // Phase I: no-op. Phase IX wires real depth + chain-length tracking
  // and trips audit + notification on excess.
  return next(payload, ctx)
}

// IX.A.1 — Per-turn / per-trigger / per-day token + cost caps.
const TokenBudgeter: Middleware = (next) => async (payload, ctx) => {
  // Phase I: no-op. Phase IX consults payload.runtimeConfig.budgetLimits.
  return next(payload, ctx)
}

// IX.A.4 — Skill cannot expand EXEC_ALLOWLIST; hooks cannot escalate
// tool allowlist above parent invocation.
const RefusalGuard: Middleware = (next) => async (payload, ctx) => {
  // Phase I: no-op. Phase IX validates the assembled tool set against
  // policy and rejects with a clear refusal if a skill/hook tried to
  // sneak something past the gate.
  return next(payload, ctx)
}

// IX.A.2 — Real confirmation flow for side-effecting tools.
const ConfirmationGate: Middleware = (next) => async (payload, ctx) => {
  // Phase I: no-op. Phase IX intercepts side-effecting tool calls,
  // emits a "agent wants to send email — approve?" chip, and only
  // resumes once the user accepts.
  return next(payload, ctx)
}

// IX.A.3 — Append-only JSONL of every side effect.
const AuditLogger: Middleware = (next) => async (payload, ctx) => {
  // Phase I: no-op. Phase IX writes to /workspace/audit.jsonl.
  return next(payload, ctx)
}

// Compose middleware in the canonical order. Apply right-to-left so
// `KillSwitch` ends up the outermost wrapper.
function compose(core: EngineRunner, middlewares: Middleware[]): EngineRunner {
  return middlewares.reduceRight<EngineRunner>(
    (next, mw) => mw(next),
    core,
  )
}

// ---
// The actual engine — pure streaming loop. Consumes a RequestPayload,
// emits Outgoing chunks. Lifted from chat.ts::handleSend with no
// behavioural changes.
// ---

const engineCore: EngineRunner = async (payload, { msg, emit, signal }) => {
  const { provider, model, systemMessages, modelMessages, tools, runtimeConfig } = payload

  // The AI SDK's streamText accepts a single combined `messages` array
  // (system messages first, conversation after). Multiple consecutive
  // system messages are preserved in the Anthropic provider as
  // independent system blocks (each with its own cache_control marker)
  // — see @ai-sdk/anthropic dist/index.mjs around L2107.
  // AI SDK v7 rejects system roles in `messages` unless
  // `allowSystemInMessages` is set (the `instructions`/`system` options
  // would collapse our blocks into one, losing per-block cache_control).
  const messages = [...systemMessages, ...modelMessages]

  let fullText = ''
  let finishReason: string | undefined
  let cancelled = false
  try {
    const result = streamText({
      model: PROVIDERS[provider].resolve(model),
      messages,
      allowSystemInMessages: true,
      ...(signal ? { abortSignal: signal } : {}),
      ...(tools ? { tools, ...(runtimeConfig.stopWhen ? { stopWhen: runtimeConfig.stopWhen } : {}) } : {}),
    })

    // Drive everything from fullStream so we can insert paragraph breaks
    // between text emissions from different steps. Without this, a turn
    // like `text → tool → text → tool → text` collapses to one wall of
    // text with no separator between sentences from different steps.
    let pendingSeparator = false
    for await (const chunk of result.fullStream) {
      switch (chunk.type) {
        case 'text-delta': {
          if (pendingSeparator && fullText.length > 0) {
            const sep = '\n\n'
            fullText += sep
            emit({ type: 'delta', id: msg.id, text: sep })
            pendingSeparator = false
          }
          fullText += chunk.text
          emit({ type: 'delta', id: msg.id, text: chunk.text })
          break
        }
        case 'text-end':
          pendingSeparator = true
          break
        case 'tool-call':
          emit({
            type: 'tool',
            id: msg.id,
            name: chunk.toolName,
            status: 'start',
            input: chunk.input,
          })
          pendingSeparator = false
          break
        case 'tool-result':
          emit({
            type: 'tool',
            id: msg.id,
            name: chunk.toolName,
            status: 'done',
            output: chunk.output,
          })
          break
        case 'source': {
          // Perplexity emits citation sources mid-stream as `source` chunks
          // (one per cited URL, in the order Sonar's [1][2]… markers
          // reference). Forward each as a `sources` event with one entry —
          // the frontend dedupes and renders them as numbered chips, same
          // pattern as Gemini grounding.
          if (chunk.sourceType === 'url') {
            emit({
              type: 'sources',
              id: msg.id,
              sources: [{ uri: chunk.url, ...(chunk.title ? { title: chunk.title } : {}) }],
            })
          }
          break
        }
        case 'finish-step': {
          // Google's grounding tool isn't a regular function call — its
          // result lands in providerMetadata.google.groundingMetadata at
          // the end of each step. Synthesize a tool chip + a sources
          // event so the UI can show what Gemini searched and cite the
          // pages it used. (Anthropic emits real tool-call events for
          // its web_search; nothing to do for them here.)
          const gm = chunk.providerMetadata?.google?.groundingMetadata as
            | {
                webSearchQueries?: string[] | null
                groundingChunks?: { web?: { uri: string; title?: string | null } | null }[] | null
              }
            | null
            | undefined
          if (gm) {
            const queries = gm.webSearchQueries ?? []
            const sources = (gm.groundingChunks ?? [])
              .map((c) => c.web)
              .filter((w): w is { uri: string; title?: string | null } => !!w?.uri)
              .map((w) => ({ uri: w.uri, ...(w.title ? { title: w.title } : {}) }))
            if (queries.length > 0 || sources.length > 0) {
              const query = queries[0]
              emit({
                type: 'tool',
                id: msg.id,
                name: 'google_search',
                status: 'start',
                input: query ? { query } : {},
              })
              emit({
                type: 'tool',
                id: msg.id,
                name: 'google_search',
                status: 'done',
                output: { sources: sources.length },
              })
              if (sources.length > 0) {
                emit({ type: 'sources', id: msg.id, sources })
              }
            }
          }
          break
        }
        case 'finish':
          finishReason = chunk.finishReason
          break
        case 'abort':
          // X.C.1 — streamText emits an `abort` chunk (not a thrown
          // error) when its abortSignal fires while the underlying
          // stream is open. Flag the turn as cancelled and break out
          // of the loop; the trailing `done`/persistence logic below
          // handles emitting the partial assistant message and the
          // `cancelled: true` done event.
          cancelled = true
          break
      }
      if (cancelled) break
    }
  } catch (e) {
    // X.C.1 — distinguish a user-issued cancel from a real error. The
    // AI SDK throws DOMException(name='AbortError') / Error(name=
    // 'AbortError') when the abortSignal fires; aborts on `signal`
    // also surface as `signal.aborted === true`. Either signal is a
    // clean cancel, not an error: emit `done` with `cancelled: true`
    // and persist whatever text the model produced so far as a
    // partial assistant message.
    const aborted =
      (e instanceof Error && e.name === 'AbortError') ||
      (signal?.aborted ?? false)
    if (aborted) {
      cancelled = true
    } else {
      emit({ type: 'error', id: msg.id, message: (e as Error).message })
      return
    }
  }

  // If the model stopped because of stopWhen (out of steps) instead of a
  // natural finish, append a small note so the user knows the reply may be
  // truncated. Anthropic returns 'stop' for normal end; 'tool-calls' or
  // similar for unfinished tool loops.
  if (
    !cancelled &&
    finishReason &&
    finishReason !== 'stop' &&
    finishReason !== 'length'
  ) {
    const note = `\n\n_(stopped: \`${finishReason}\` — turn may be incomplete; try again or break the request into smaller steps)_`
    fullText += note
    emit({ type: 'delta', id: msg.id, text: note })
  }

  if (fullText) {
    await appendConversation(msg.sessionId, {
      ts: new Date().toISOString(),
      role: 'assistant',
      text: fullText,
      provider,
      model,
      id: msg.id,
      ...(cancelled ? { partial: true } : {}),
    })
  }

  emit({
    type: 'done',
    id: msg.id,
    provider,
    model,
    ...(cancelled ? { cancelled: true } : {}),
  })
}

// Wrap the core engine with the Phase-I no-op middleware stack. Order
// per AGENT_ARCHITECTURE.md L800.
const wrappedRun: EngineRunner = compose(engineCore, [
  KillSwitch,
  TokenBudgeter,
  RefusalGuard,
  ConfirmationGate,
  AuditLogger,
])

// ---
// Public entry point — what index.ts calls when the WebSocket
// receives a `send` frame. Mirrors the old chat.ts::handleSend
// signature so the rewrite is a one-line import change at the call
// site.
// ---

export async function run(
  msg: IncomingSend,
  emit: (out: Outgoing) => void,
  ctx: { userId: string; signal?: AbortSignal },
): Promise<void> {
  let invocation
  try {
    invocation = dispatchUser(msg, ctx)
  } catch (e) {
    emit({ type: 'error', id: msg.id, message: (e as Error).message })
    return
  }

  // Persist the user message with the same id as the inbound frame so
  // the rewind handler (X.C.2) can use that id as a truncation anchor.
  // Both user and assistant entries carry the turn's id.
  await appendConversation(msg.sessionId, {
    ts: new Date().toISOString(),
    role: 'user',
    text: msg.content,
    id: msg.id,
  })

  const payload = await PromptAssembler.build(invocation)
  await wrappedRun(payload, { msg, emit, signal: ctx.signal })
}
