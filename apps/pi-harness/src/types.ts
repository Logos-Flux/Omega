// Shared type contracts for the dispatcher / assembler / engine subsystems.
// Shapes are taken from docs/AGENT_ARCHITECTURE.md (the canonical ones — do
// not invent extras here without updating the doc).

import type { ModelMessage, StopCondition, ToolSet } from 'ai'
import type { ProviderId } from './providers'

// ---
// Dispatcher → assembler contract.
// ---

export type TriggerSource = 'user' | 'schedule' | 'event' | 'agent'

export type InputType = 'prompt' | 'quick_action' | 'slash' | 'continuation'

/**
 * Per-invocation budget caps. Phase I just declares the shape; the real
 * TokenBudgeter middleware that consults this lands in Phase IX.
 */
export interface BudgetSpec {
  maxTokens?: number
  maxToolCalls?: number
  maxCostUsd?: number
}

/**
 * Policy flags that affect tool gating, confirmation, refusal, kill-switch.
 * Phase I-stub middleware ignores these; Phase IX wires them up.
 */
export interface PolicySpec {
  confirmation?: 'never' | 'side_effects' | 'explicit'
  toolsDenied?: string[]
  killSwitchOverride?: boolean
}

/**
 * Where the response goes. For user-triggered turns this is always 'ws'
 * (stream over the websocket back to the originating session). Scheduled
 * and event-triggered invocations may use 'inbox' so the user sees the
 * delivery on next reconnect (see Phase VIII).
 */
export type DeliveryChannel = 'ws' | 'inbox' | 'silent'

/**
 * What the dispatcher hands to the assembler. The assembler is responsible
 * for resolving everything that goes into the system prefix; the
 * Invocation only carries identifiers + the final user-facing prompt.
 */
export interface Invocation {
  trigger: TriggerSource
  triggerPayload?: unknown
  inputType?: InputType
  quickActionId?: string
  sessionId: string
  userId: string
  personaName: string
  soulName: string
  prompt: string
  provider: ProviderId
  model: string
  /** IANA timezone for anchoring "today" + current time in the system
   *  prompt. Sourced from the inbound send frame; the assembler falls back
   *  to profile.timezone and then UTC when absent. */
  timezone?: string
  budget: BudgetSpec
  policy: PolicySpec
  delivery: DeliveryChannel
}

// ---
// Assembler → engine contract.
// ---

/**
 * Output of the assembler. `systemMessages` is the prefix (one message per
 * active slot, ordered 1..15). `modelMessages` is the conversation +
 * latest user turn. The engine concatenates them and hands the lot to
 * `streamText`.
 */
export interface RequestPayload {
  systemMessages: ModelMessage[]
  tools: ToolSet | undefined
  modelMessages: ModelMessage[]
  runtimeConfig: {
    stopWhen?: StopCondition<ToolSet>
    budgetLimits: BudgetSpec
  }
  provider: ProviderId
  model: string
}

// ---
// Wire types — exchanged with the chat-frontend over the WebSocket.
// Same shapes as before the refactor, kept here so other modules don't
// need to depend on `chat.ts` (which is being deleted).
// ---

export interface IncomingSend {
  type: 'send'
  id: string
  sessionId: string
  content: string
  provider?: string
  model?: string
  /** IANA timezone of the sender's browser (e.g. "America/New_York"). Sent
   *  per-message so the assembler can localize "today" + the current time.
   *  Optional; absent frames fall back to profile.timezone, then UTC. */
  timezone?: string
}

/**
 * Cancel frame (X.C.1). Tells the harness to abort the in-flight turn
 * whose response id is `id`. No-op if no turn matches.
 */
export interface IncomingCancel {
  type: 'cancel'
  id: string
}

/**
 * Rewind frame (X.C.2). Tells the harness to truncate the conversation
 * file so `toMessageId` is the last surviving entry. The optional `id`
 * is the frame's own correlation id, so if the harness needs to emit an
 * error event the frontend can match it; if absent we use `toMessageId`.
 */
export interface IncomingRewind {
  type: 'rewind'
  id?: string
  toMessageId: string
}

export type Incoming = IncomingSend | IncomingCancel | IncomingRewind

export type Outgoing =
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
  | {
      type: 'done'
      id: string
      provider: ProviderId
      model: string
      // True when the turn ended because a `cancel` frame aborted the
      // streamText loop, not because the model finished naturally. The
      // partial assistant text up to the abort point is still appended
      // to conversation.jsonl with `partial: true`.
      cancelled?: boolean
    }
  | { type: 'error'; id: string; message: string }
  | { type: 'rewind_done'; id?: string; toMessageId: string }
