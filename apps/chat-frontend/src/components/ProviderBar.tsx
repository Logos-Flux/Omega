import {
  PROVIDERS,
  useProviderSelection,
  type ProviderId,
  type Tier,
} from '../lib/provider-store'
import { useAgentMode } from '../lib/agent-mode'
import { useThreadLock } from '../lib/thread-lock'
import { useThreadNav } from '../App'
import { cn } from '../lib/cn'

const ORDER: ProviderId[] = ['anthropic', 'google', 'perplexity']

export function ProviderBar() {
  const { provider, tier, model, setProvider, setTier } = useProviderSelection()
  const { agentMode } = useAgentMode()
  const lock = useThreadLock()
  const { newThread } = useThreadNav()

  // I.D.2 — only chat-api threads carry a lock (the harness owns its own
  // jsonl-backed conversation history). Suppress the indicator in agent
  // mode so the bar stays unobtrusive there.
  const lockActive = !agentMode && lock.provider !== null && lock.model !== null
  const mismatched =
    lockActive && (lock.provider !== provider || lock.model !== model)

  const startFreshWithCurrent = () => {
    // newThread() drops the lock; the next /api/chat response will lock the
    // brand-new thread to whatever provider/model is currently selected.
    newThread()
  }

  return (
    <div className="mb-2 flex w-full max-w-[var(--thread-max-width)] flex-col gap-1.5">
      <div className="flex w-full flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          {ORDER.map((id) => (
            <ProviderLogo
              key={id}
              id={id}
              label={PROVIDERS[id].label}
              active={provider === id}
              onClick={() => setProvider(id)}
            />
          ))}
        </div>

        <div className="inline-flex overflow-hidden rounded-md border border-t-border bg-t-surface">
          {(['basic', 'advanced'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTier(t)}
              className={cn(
                'px-3 py-1 font-display text-[10px] uppercase tracking-[0.15em] transition-colors',
                tier === t ? 'bg-t-accent-alt text-white' : 'text-t-muted hover:bg-t-hover',
              )}
              aria-pressed={tier === t}
            >
              {t}
            </button>
          ))}
        </div>

        <span className="font-mono text-[10px] text-t-muted">{model}</span>

        <div className="ml-auto">
          <AgentModeToggle />
        </div>
      </div>

      {mismatched && <CacheSwitchIndicator onStartFresh={startFreshWithCurrent} />}
    </div>
  )
}

// Inline cache-invalidation indicator — small, unobtrusive, matched to the
// 52L design tokens. The user can still send (the chat-api will silently
// re-lock to the new pair when override:true is sent), but the cost is
// surfaced rather than hidden. Per AGENT_ARCHITECTURE.md L386-388 the
// switch is allowed; this is just a heads-up.
function CacheSwitchIndicator({ onStartFresh }: { onStartFresh: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-t-accent-alt/30 bg-t-accent-alt/5 px-2 py-1.5 text-[11px] text-t-accent-alt">
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-t-accent-alt" />
      <span className="text-t-accent-alt/90">
        Switching mid-thread invalidates the cache and may slow the next turn.
      </span>
      <button
        type="button"
        onClick={onStartFresh}
        className="ml-auto rounded border border-t-accent-alt/40 px-2 py-0.5 font-display text-[10px] uppercase tracking-[0.15em] text-t-accent-alt transition-colors hover:bg-t-accent-alt/10"
      >
        Start a fresh thread with this provider
      </button>
    </div>
  )
}

function AgentModeToggle() {
  const { agentMode, toggleAgentMode } = useAgentMode()
  return (
    <button
      type="button"
      onClick={toggleAgentMode}
      role="switch"
      aria-checked={agentMode}
      aria-label="Agent Mode"
      title={
        agentMode
          ? 'Agent Mode on — chat is backed by the Pi harness (skills, files, tools).'
          : 'Agent Mode off — chat uses the lower-latency chat-api runtime.'
      }
      className={cn(
        'group inline-flex items-center gap-2 rounded-md border px-2 py-1 transition-colors',
        agentMode
          ? 'border-t-accent-alt/40 bg-t-accent-alt/5 text-t-accent-alt hover:bg-t-accent-alt/10'
          : 'border-t-border bg-t-surface text-t-muted hover:bg-t-hover',
      )}
    >
      <span className="font-display text-[10px] uppercase tracking-[0.15em]">Agent</span>
      <span
        className={cn(
          'relative inline-block h-3.5 w-7 rounded-full transition-colors',
          agentMode ? 'bg-t-accent-alt' : 'bg-t-border',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow transition-all',
            agentMode ? 'left-3.5' : 'left-0.5',
          )}
        />
      </span>
    </button>
  )
}

interface LogoButtonProps {
  id: ProviderId
  label: string
  active: boolean
  onClick: () => void
}

function ProviderLogo({ id, label, active, onClick }: LogoButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'relative flex h-9 w-9 items-center justify-center rounded-md border transition-all',
        active
          ? 'border-t-accent-alt bg-t-accent-alt text-white shadow-[0_0_0_2px_rgba(255,90,78,0.18)]'
          : 'border-t-border bg-t-surface text-t-muted hover:border-t-border-active hover:text-t-bright',
      )}
    >
      <ProviderMark id={id} />
    </button>
  )
}

function ProviderMark({ id }: { id: ProviderId }) {
  switch (id) {
    case 'anthropic':
      return <AnthropicMark />
    case 'google':
      return <GeminiMark />
    case 'perplexity':
      return <PerplexityMark />
  }
}

function AnthropicMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
      <path d="M14.5 4h-3l5 16h3l-5-16zM7.5 4L2 20h3l1.1-3.4h6.4L13.6 20h3L11.1 4h-3.6zm-.4 9.8L9.3 7.6l2.2 6.2H7.1z" />
    </svg>
  )
}

function GeminiMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
      <path d="M12 2c.4 4.7 2.7 7.6 7.4 8.6-4.7.8-7 3.5-7.4 8.4-.4-4.9-2.7-7.6-7.4-8.4 4.7-1 7-3.9 7.4-8.6z" />
    </svg>
  )
}

function PerplexityMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-5 w-5">
      <path d="M12 3v18" />
      <path d="M5 7v10" />
      <path d="M19 7v10" />
      <path d="M12 3l7 4" />
      <path d="M12 3L5 7" />
      <path d="M12 21l-7-4" />
      <path d="M12 21l7-4" />
    </svg>
  )
}

export type { Tier }
