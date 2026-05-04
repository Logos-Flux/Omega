// Surfaces the sprite-warmup state to the user. Without this, the
// background /api/session/start that fires on sign-in is invisible —
// users see no indication that toggling Agent Mode early would just
// stall on "loading session" for ~3 minutes. The banner removes that
// surprise: it tells them their environment is being prepared, lets
// them keep using chat-api in the meantime, and disappears once the
// sprite is warm. On failure it offers a retry.
//
// Hidden when the warmup state is `idle` (provider hasn't fired yet)
// or `ready` (no signal needed). Only ever visible during the slow
// first-sign-in path; on subsequent visits the existing-row fast path
// resolves in seconds and the banner barely flashes.

import { useSpriteWarmup } from '../lib/sprite-warmup'

export function SpriteWarmupBanner() {
  const { state, retry } = useSpriteWarmup()

  if (state.kind === 'idle' || state.kind === 'ready') return null

  if (state.kind === 'not_provisioned' || state.kind === 'sprite_missing') {
    // Pre-provisioned-only mode: agent unavailable until an operator runs
    // `bun scripts/provision-user.ts <email>`. No retry button — the user
    // can't self-heal these states; they need an admin.
    const headline =
      state.kind === 'not_provisioned'
        ? 'Agent not provisioned for your account'
        : 'Agent sprite missing'
    const detail =
      state.kind === 'not_provisioned'
        ? 'Chat works normally. Contact your admin to enable agent mode.'
        : 'Your sprite was reset. Chat works normally; contact your admin to re-provision.'
    return (
      <div className="flex items-center gap-3 border-b border-t-warning/40 bg-t-warning/10 px-4 py-2">
        <span className="font-display text-[10px] uppercase tracking-[0.18em] text-t-warning">
          {headline}
        </span>
        <span className="font-terminal text-[11px] text-t-muted truncate">{detail}</span>
      </div>
    )
  }

  if (state.kind === 'failed') {
    return (
      <div className="flex items-center gap-3 border-b border-t-warning/40 bg-t-warning/10 px-4 py-2">
        <span className="font-display text-[10px] uppercase tracking-[0.18em] text-t-warning">
          Agent setup failed
        </span>
        <span className="font-terminal text-[11px] text-t-muted truncate">
          {state.reason}
        </span>
        <button
          type="button"
          onClick={retry}
          className="ml-auto rounded border border-t-warning/50 px-2 py-0.5 font-display text-[10px] uppercase tracking-[0.15em] text-t-warning transition-colors hover:bg-t-warning/10"
        >
          Retry
        </button>
      </div>
    )
  }

  // provisioning
  return (
    <div className="flex items-center gap-3 border-b border-t-accent-alt/40 bg-t-accent-alt/5 px-4 py-2">
      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-t-accent-alt animate-pulse" />
      <span className="font-display text-[10px] uppercase tracking-[0.18em] text-t-accent-alt">
        Preparing your agent environment
      </span>
      <span className="font-terminal text-[11px] text-t-muted">
        First sign-in takes ~3 minutes. Chat works normally in the meantime;
        agent tools become available when this finishes.
      </span>
    </div>
  )
}
