// Dispatcher — one module, four entry points (one per trigger source).
// Each entry point's job is to construct an Invocation record and hand
// it off (via the assembler) to the engine. Per AGENT_ARCHITECTURE.md
// L226-256, the dispatcher does NOT assemble system messages or call
// the model; it only resolves "given this trigger, what is the
// Invocation."
//
// In Phase I (this commit) only `dispatchUser` is wired. The other
// three entry points exist as stubs that throw NotImplementedError so
// the rest of the codebase can already reference them and we can spot
// any caller that thinks they're live before the relevant phase lands.

import { DEFAULT_PROVIDER, DEFAULT_MODEL, isValidSelection, type ProviderId } from './providers'
import { readStateSync } from './state'
import type { IncomingSend, Invocation } from './types'

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotImplementedError'
  }
}

/**
 * Default budget for a user-triggered turn. Real values land in IX.A
 * with the TokenBudgeter middleware; Phase I just declares the shape.
 */
const USER_DEFAULT_BUDGET = {} as const

/**
 * Default policy for a user-triggered turn. Real values land in IX.A
 * with ConfirmationGate / RefusalGuard. Phase I leaves it permissive.
 */
const USER_DEFAULT_POLICY = {} as const

/**
 * Active soul name. Phase I has exactly one; resolution from user state
 * lands in V. (Active persona now resolves from state.json via
 * readStateSync() — see resolveActivePersona below.)
 */
const PHASE_I_SOUL = 'default'

/**
 * Resolve the active persona name from /workspace/state.json. Delegates
 * to the shared state module (readStateSync), which is forgiving — a
 * missing/malformed file resolves to the 'default' persona rather than
 * throwing, so a bad state.json never takes the dispatcher down.
 */
function resolveActivePersona(): string {
  return readStateSync().activePersona
}

/**
 * Build an Invocation from an inbound user `send` frame. This is the
 * one entry point wired to real machinery in Phase I.
 *
 * The caller (engine.run, via index.ts's WebSocket handler) is
 * responsible for validating provider/model selection and for actually
 * running the assembled payload. The dispatcher only constructs the
 * Invocation record.
 */
export function dispatchUser(
  msg: IncomingSend,
  ctx: { userId: string },
): Invocation {
  const providerInput = msg.provider ?? DEFAULT_PROVIDER
  const modelInput = msg.model ?? DEFAULT_MODEL
  if (!isValidSelection(providerInput, modelInput)) {
    throw new Error(`unknown provider/model: ${providerInput}/${modelInput}`)
  }
  const provider = providerInput as ProviderId

  return {
    trigger: 'user',
    inputType: 'prompt',
    sessionId: msg.sessionId,
    userId: ctx.userId,
    personaName: resolveActivePersona(),
    soulName: PHASE_I_SOUL,
    prompt: msg.content,
    provider,
    model: modelInput,
    timezone: msg.timezone,
    budget: { ...USER_DEFAULT_BUDGET },
    policy: { ...USER_DEFAULT_POLICY },
    delivery: 'ws',
  }
}

/**
 * Scheduled (cron) trigger entry point. Activates in Phase VIII (cron
 * table + setInterval inside the harness). Throws until then so we
 * can't accidentally ship a half-baked code path that runs side-effects
 * unchecked.
 */
export function dispatchSchedule(_payload: unknown): Invocation {
  throw new NotImplementedError(
    'dispatchSchedule activates in Phase VIII (cron + watchers); see ROADMAP.md §VIII.A',
  )
}

/**
 * Event-source trigger entry point (gmail-watcher, calendar-watcher,
 * etc.). Activates in Phase VIII alongside dispatchSchedule.
 */
export function dispatchEvent(_payload: unknown): Invocation {
  throw new NotImplementedError(
    'dispatchEvent activates in Phase VIII (cron + watchers); see ROADMAP.md §VIII.B',
  )
}

/**
 * Agent-triggered continuation entry point (a previous turn's tool
 * call enqueued a follow-up). Activates in Phase IX with the
 * KillSwitch middleware in place — without it, an agent loop could
 * recurse without bound.
 */
export function dispatchAgent(_payload: unknown): Invocation {
  throw new NotImplementedError(
    'dispatchAgent activates in Phase IX (policy middleware); see ROADMAP.md §IX.B',
  )
}
