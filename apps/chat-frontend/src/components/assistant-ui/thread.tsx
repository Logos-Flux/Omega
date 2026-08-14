import {
  ActionBarPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from '@assistant-ui/react'
import { useQuickActions } from '../../lib/quick-actions'
import { brand } from '../../lib/brand'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CopyIcon,
  CheckIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
  Wrench,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import type { ToolCallMessagePartComponent } from '@assistant-ui/react'
import { MarkdownText } from './markdown-text'
import { TooltipIconButton } from './tooltip-icon-button'
import { ProviderBar } from '../ProviderBar'
import { FileCard } from '../FileCard'
import { summarizeToolInput } from '../../lib/harness-utils'

export function Thread() {
  return (
    <ThreadPrimitive.Root
      className="flex h-full flex-col bg-t-deep"
      style={{ ['--thread-max-width' as string]: '40rem' }}
    >
      <ThreadPrimitive.Viewport className="flex h-full flex-col items-center overflow-y-auto px-4 pt-6">
        <ThreadWelcome />
        <ThreadPrimitive.Messages
          components={{
            UserMessage,
            AssistantMessage,
            EditComposer,
          }}
        />
        <ThreadPrimitive.If empty={false}>
          <div className="min-h-6 w-full max-w-[var(--thread-max-width)] grow" />
        </ThreadPrimitive.If>
        <ThreadScrollToBottom />
        <Composer />
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}

function ThreadScrollToBottom() {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        className="absolute bottom-24 right-6 z-10 rounded-full border border-t-border bg-t-surface shadow-lg disabled:invisible"
      >
        <ArrowDownIcon className="h-4 w-4" />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  )
}

function ThreadWelcome() {
  return (
    <ThreadPrimitive.Empty>
      <div className="flex w-full max-w-[var(--thread-max-width)] flex-grow flex-col items-center justify-center text-center">
        <div className="mb-3 inline-block px-3 py-1 text-[10px] font-display uppercase tracking-[0.2em] text-t-accent border border-t-accent/40 rounded">
          {brand.name}
        </div>
        <h1 className="mb-2 text-3xl font-display font-semibold text-t-bright">
          How can I help?
        </h1>
        <p className="mb-6 text-sm text-t-muted">
          Ask anything to get started.
        </p>
        <ThreadWelcomeSuggestions />
      </div>
    </ThreadPrimitive.Empty>
  )
}

// Quick-action cards. Empty in OSS by default — the empty state is
// just headline + tagline + composer. Deployments that want curated
// prompt cards populate the array via <QuickActionsProvider> in
// App.tsx (see lib/quick-actions.tsx + docs/CUSTOMIZATION.md).
function ThreadWelcomeSuggestions() {
  const { actions, onSelect } = useQuickActions()
  if (actions.length === 0) return null

  return (
    <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          onClick={() => onSelect(action)}
          className="t-card group relative flex flex-col items-start gap-1 p-3 text-left transition-colors hover:border-t-border-active hover:bg-t-hover"
        >
          {action.badge && (
            <span className="absolute right-2 top-2 rounded border border-t-accent-alt/40 bg-t-accent-alt/5 px-1.5 py-0.5 text-[9px] font-display uppercase tracking-wider text-t-accent-alt opacity-80 group-hover:opacity-100">
              {action.badge}
            </span>
          )}
          <span className="pr-20 text-xs font-display uppercase tracking-wider text-t-accent">
            {action.label}
          </span>
          {action.description && (
            <span className="text-sm leading-snug text-t-text">{action.description}</span>
          )}
        </button>
      ))}
    </div>
  )
}

function Composer() {
  return (
    <div className="sticky bottom-0 mt-4 flex w-full max-w-[var(--thread-max-width)] flex-col items-center bg-gradient-to-t from-t-deep via-t-deep/95 to-transparent pb-6 pt-4">
      <ProviderBar />
      <ComposerPrimitive.Root className="flex w-full items-end gap-2 rounded-2xl border border-t-border bg-t-surface px-4 py-3 shadow-sm transition-all focus-within:border-t-border-active focus-within:shadow-[0_4px_24px_-6px_rgba(43,58,162,0.18)]">
        <ComposerPrimitive.Input
          rows={1}
          autoFocus
          placeholder="Ask anything…"
          className="placeholder:text-t-muted max-h-40 flex-1 resize-none border-none bg-transparent px-1 py-1.5 text-base text-t-bright outline-none disabled:cursor-not-allowed"
        />
        <ComposerAction />
      </ComposerPrimitive.Root>
    </div>
  )
}

function ComposerAction() {
  return (
    <>
      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send asChild>
          <TooltipIconButton
            tooltip="Send"
            className="h-9 w-9 rounded-full bg-t-accent text-white hover:bg-t-accent hover:text-white hover:opacity-90 disabled:bg-t-hover disabled:text-t-muted"
          >
            <ArrowUpIcon className="h-4 w-4" />
          </TooltipIconButton>
        </ComposerPrimitive.Send>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel asChild>
          <TooltipIconButton
            tooltip="Stop"
            className="h-9 w-9 rounded-full bg-t-accent-alt text-white hover:bg-t-accent-alt hover:text-white hover:opacity-90"
          >
            <SquareIcon className="h-3.5 w-3.5 fill-current" />
          </TooltipIconButton>
        </ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
    </>
  )
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="grid w-full max-w-[var(--thread-max-width)] auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] gap-y-2 py-3">
      <UserActionBar />
      <div className="col-start-2 max-w-[80%] rounded-md border border-t-border bg-t-surface px-4 py-2 text-sm text-t-bright break-words">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  )
}

function UserActionBar() {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="col-start-1 row-start-1 mr-3 mt-2 flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="Edit">
          <PencilIcon className="h-3.5 w-3.5" />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  )
}

function EditComposer() {
  return (
    <ComposerPrimitive.Root className="my-3 flex w-full max-w-[var(--thread-max-width)] flex-col gap-2 rounded border border-t-border-active bg-t-surface p-3">
      <ComposerPrimitive.Input
        className="min-h-[60px] w-full resize-none bg-transparent text-sm text-t-bright outline-none"
      />
      <div className="flex justify-end gap-2">
        <ComposerPrimitive.Cancel asChild>
          <button className="rounded px-3 py-1 text-xs uppercase tracking-wider text-t-muted hover:text-t-bright hover:bg-t-hover transition-colors">
            Cancel
          </button>
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send asChild>
          <button className="rounded bg-t-accent px-3 py-1 text-xs uppercase tracking-wider text-white hover:opacity-90 transition-opacity">
            Send
          </button>
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  )
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="grid w-full max-w-[var(--thread-max-width)] grid-cols-[auto_1fr] grid-rows-[auto_1fr] gap-y-1 py-3">
      <div className="col-start-1 row-start-1 mr-3 flex h-8 w-8 shrink-0 items-center justify-center rounded border border-t-border bg-t-surface font-display text-xs uppercase text-t-accent">
        {brand.glyph}
      </div>
      <div className="col-start-2 row-start-1 my-0.5 max-w-[calc(var(--thread-max-width)-3rem)] break-words text-sm text-t-bright">
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            Source: SourcePart,
            // Render every tool call from the harness (read_skill,
            // exec, web_search, write_memory, etc.) as a generic chip.
            // Names aren't pre-registered — the harness can introduce
            // new tools at any time, so a Fallback that handles all of
            // them is the right shape.
            tools: { Fallback: ToolCallChip },
            // Download cards for files the agent generated mid-turn.
            // The HarnessTransport emits `data-file` chunks on `done`
            // for each new upload it detected post-turn. (See
            // harness-transport.ts uploadsBeforePromise diff.)
            data: { by_name: { file: FileCard } },
          }}
        />
      </div>
      <AssistantActionBar />
    </MessagePrimitive.Root>
  )
}

// Generic tool-call chip. Renders any tool the harness fires —
// `read_skill <name>`, `exec <cmd>`, `web_search <query>`, etc. — as a
// compact pill that expands its arguments inline. The harness emits
// tool-input-available with full args up front (we don't stream args),
// then tool-output-available when the tool completes; we surface that
// as a status icon so the user can tell what's running vs. done.
const ToolCallChip: ToolCallMessagePartComponent = ({
  toolName,
  args,
  result,
  isError,
}) => {
  const status: 'running' | 'done' | 'error' =
    isError ? 'error' : result !== undefined ? 'done' : 'running'
  const hint = summarizeToolInput(toolName, args)
  const Icon = status === 'done' ? CheckCircle2 : status === 'error' ? XCircle : Wrench
  const cls =
    status === 'error'
      ? 'border-t-error/40 bg-t-error/5 text-t-error'
      : status === 'done'
        ? 'border-t-success/40 bg-t-success/5 text-t-success'
        : 'border-t-accent/40 bg-t-accent/5 text-t-accent animate-pulse'
  return (
    <div
      className={`my-1 inline-flex max-w-full items-center gap-1.5 rounded border px-2 py-1 align-middle font-mono text-[11px] ${cls}`}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="font-display font-semibold uppercase tracking-wider">
        {toolName}
      </span>
      {hint && (
        <span className="truncate text-t-muted" title={hint}>
          {hint}
        </span>
      )}
    </div>
  )
}

// Accepts the full 0.15 source-part union: url sources (Perplexity,
// Gemini grounding) and document sources, whose `url` is undefined.
function SourcePart({ id, url, title }: { id: string; url?: string; title?: string }) {
  // The selector must return a referentially stable value — returning a
  // fresh array (e.g. `s.message.content.filter(...)`) would defeat the
  // Object.is comparison and re-render on every store update, which
  // surfaced as a white screen the moment any source-emitting provider
  // answered. A primitive (number | null) is always safe.
  const num = useAuiState((s) => {
    if (s.message.role !== 'assistant') return null
    const parts = s.message.content as ReadonlyArray<{ type: string; id?: string }>
    const idx = parts.filter((p) => p.type === 'source').findIndex((p) => p.id === id)
    return idx >= 0 ? idx + 1 : null
  })
  // Document sources carry no link; the harness only emits url sources.
  if (!url) return null
  const display =
    title || (() => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url } })()
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="my-0.5 mr-1.5 inline-flex max-w-full items-center gap-1 rounded border border-t-border bg-t-surface px-2 py-0.5 align-middle font-mono text-[11px] text-t-accent transition-colors hover:border-t-accent hover:bg-t-accent/5"
      title={url}
    >
      {num !== null && (
        <span className="font-display text-[10px] font-semibold tabular-nums text-t-accent-alt">
          [{num}]
        </span>
      )}
      <span className="truncate">{display}</span>
    </a>
  )
}

function AssistantActionBar() {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      autohideFloat="single-branch"
      className="col-start-2 row-start-2 -ml-1 flex gap-1 text-t-muted"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <MessagePrimitive.If copied>
            <CheckIcon className="h-3.5 w-3.5" />
          </MessagePrimitive.If>
          <MessagePrimitive.If copied={false}>
            <CopyIcon className="h-3.5 w-3.5" />
          </MessagePrimitive.If>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="Refresh">
          <RefreshCwIcon className="h-3.5 w-3.5" />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
    </ActionBarPrimitive.Root>
  )
}
