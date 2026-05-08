import { useState } from 'react'
import {
  Plus,
  MessageSquare,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Paperclip,
  FileText,
  User,
  BookMarked,
  X,
} from 'lucide-react'
import { useThreadNav } from '../App'
import { useAgentMode } from '../lib/agent-mode'
import { useHarnessSession } from '../lib/harness-session'
import { formatBytes } from '../lib/harness-utils'
import { cn } from '../lib/cn'

type DrawerSection = 'chat' | 'uploads' | 'skills' | 'persona' | 'memories'

export function ChatDrawer() {
  const { activeThreadId, threads, selectThread, newThread } = useThreadNav()
  const { agentMode } = useAgentMode()
  const { uploads, skills } = useHarnessSession()
  const [openSection, setOpenSection] = useState<DrawerSection | null>('chat')
  const toggle = (s: DrawerSection) => setOpenSection((cur) => (cur === s ? null : s))

  return (
    <div className="flex h-full flex-col bg-t-bright text-white">
      <div className="border-b border-white/10 px-4 py-4">
        <p className="text-[10px] font-medium uppercase tracking-wider text-t-accent-alt">
          Omega
        </p>
        <p className="text-[10px] text-white/40 mt-0.5">
          {agentMode ? 'Agent Mode — Pi harness via Sprites' : 'Workspace'}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        <Accordion
          label="Chat"
          icon={<MessageSquare className="h-3 w-3" />}
          count={agentMode ? undefined : threads.length}
          open={openSection === 'chat'}
          onToggle={() => toggle('chat')}
        >
          <div className="space-y-3">
            <button
              type="button"
              onClick={newThread}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-t-accent-alt/30 bg-t-accent-alt/10 px-3 py-2 text-[11px] font-display uppercase tracking-wider text-t-accent-alt transition-colors hover:bg-t-accent-alt/20 hover:border-t-accent-alt/50"
            >
              <Plus className="h-3 w-3" />
              New chat
            </button>
            {agentMode ? (
              <SessionStatus />
            ) : (
              <ThreadsList
                threads={threads}
                activeThreadId={activeThreadId}
                selectThread={selectThread}
              />
            )}
          </div>
        </Accordion>

        {agentMode && (
          <>
            <Accordion
              label="Uploads"
              icon={<Paperclip className="h-3 w-3" />}
              count={uploads.length}
              open={openSection === 'uploads'}
              onToggle={() => toggle('uploads')}
            >
              <UploadsList />
            </Accordion>

            <Accordion
              label="Skills"
              icon={<Sparkles className="h-3 w-3" />}
              count={skills.length}
              open={openSection === 'skills'}
              onToggle={() => toggle('skills')}
            >
              <SkillsList />
            </Accordion>
          </>
        )}

        <Accordion
          label="Persona"
          icon={<User className="h-3 w-3" />}
          open={openSection === 'persona'}
          onToggle={() => toggle('persona')}
        >
          <PersonaPlaceholder />
        </Accordion>

        <Accordion
          label="Memories"
          icon={<BookMarked className="h-3 w-3" />}
          open={openSection === 'memories'}
          onToggle={() => toggle('memories')}
        >
          <MemoriesPlaceholder />
        </Accordion>
      </div>

      <div className="border-t border-white/10 px-4 py-3">
        <p className="text-[10px] text-white/30">
          {agentMode ? 'harness • shared sprite (testing)' : 'chat-frontend v0.1.0'}
        </p>
      </div>
    </div>
  )
}

function PersonaPlaceholder() {
  return (
    <div className="rounded border border-dashed border-white/10 p-3 text-[11px] leading-relaxed text-white/40">
      <p className="font-display uppercase tracking-[0.15em] text-white/30 text-[9px] mb-1">
        Phase VI
      </p>
      Tone, communication style, and assistant personality preferences. Not
      wired yet — backed by the same persona stub in Settings.
    </div>
  )
}

function MemoriesPlaceholder() {
  return (
    <div className="rounded border border-dashed border-white/10 p-3 text-[11px] leading-relaxed text-white/40">
      <p className="font-display uppercase tracking-[0.15em] text-white/30 text-[9px] mb-1">
        Coming
      </p>
      Long-term facts the assistant remembers about you across sessions.
      Definition pending — needs schema, storage, and capture rules before
      any UI ships.
    </div>
  )
}

function ThreadsList({
  threads,
  activeThreadId,
  selectThread,
}: {
  threads: { id: string; title: string | null; updated_at: string }[]
  activeThreadId: string
  selectThread: (id: string) => void
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[9px] font-display uppercase tracking-[0.15em] text-white/30">
        <MessageSquare className="h-3 w-3" />
        <span>Threads</span>
        <span className="ml-auto font-mono normal-case tracking-normal text-white/40">
          {threads.length}
        </span>
      </div>
      {threads.length === 0 ? (
        <p className="rounded border border-dashed border-white/10 p-2 text-[11px] leading-relaxed text-white/40">
          No threads yet. Start a new chat to see it here.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {threads.map((t) => {
            const active = t.id === activeThreadId
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => selectThread(t.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded border-l-2 px-2 py-1.5 text-left text-xs transition-colors',
                    active
                      ? 'border-t-accent-alt bg-t-accent-alt/10 text-t-accent-alt'
                      : 'border-transparent text-white/60 hover:border-t-accent-alt hover:bg-white/5 hover:text-white',
                  )}
                >
                  <MessageSquare className="h-3 w-3 shrink-0" />
                  <span className="truncate">{t.title || 'Untitled'}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// In agent mode threads live as jsonl in /workspace/conversations/ on
// the harness side (not in chat-api's Postgres), so the Chat accordion
// shows the harness session status instead of the threads list.
function SessionStatus() {
  const { session } = useHarnessSession()
  if (!session) {
    return (
      <p className="text-[10px] font-display uppercase tracking-[0.15em] text-white/30">
        Waiting for harness…
      </p>
    )
  }
  let host = '—'
  try {
    host = new URL(session.container.url).hostname
  } catch {
    /* ignore */
  }
  return (
    <div className="space-y-2 text-[11px] text-white/70">
      <Field label="Sprite" value={session.container.name} />
      <Field label="Provider" value={session.container.provider} />
      <Field label="Session" value={session.sessionId.slice(0, 8)} mono />
      <Field label="URL" value={host} mono />
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[9px] font-display uppercase tracking-[0.15em] text-white/30">{label}</p>
      <p className={cn('mt-0.5 text-white/80', mono && 'font-mono')}>{value}</p>
    </div>
  )
}

function Accordion({
  label,
  count,
  icon,
  open,
  onToggle,
  children,
}: {
  label: string
  count?: number
  icon: React.ReactNode
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="border-t border-white/10">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'flex w-full items-center gap-2 px-4 py-2.5 text-left text-[11px] font-display uppercase tracking-[0.15em] transition-colors',
          open
            ? 'bg-white/5 text-white'
            : 'text-white/60 hover:bg-white/5 hover:text-white',
        )}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {icon}
        <span>{label}</span>
        {typeof count === 'number' && (
          <span className="ml-auto text-white/30 font-mono normal-case tracking-normal">
            {count}
          </span>
        )}
      </button>
      {open && <div className="px-3 pb-3 pt-1">{children}</div>}
    </div>
  )
}

function UploadsList() {
  const { uploads, downloadUrlFor, session, uploadFiles, deleteUpload, uploadingCount, uploadError } =
    useHarnessSession()
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  if (!session) {
    return (
      <p className="text-[10px] text-white/30 px-1">
        Connect the harness to manage uploads.
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <label className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-dashed border-white/15 px-2 py-2 text-[10px] font-display uppercase tracking-[0.15em] text-white/50 transition-colors hover:border-t-accent-alt/40 hover:text-t-accent-alt">
        <Paperclip className="h-3 w-3" />
        <span>{uploadingCount > 0 ? `Uploading ${uploadingCount}…` : 'Add file'}</span>
        <input
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void uploadFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </label>
      {uploadError && (
        <p className="rounded border border-red-500/40 bg-red-500/5 px-2 py-1 text-[10px] text-red-400">
          {uploadError}
        </p>
      )}
      {uploads.length === 0 ? (
        <p className="text-[10px] text-white/30 px-1">No uploads yet.</p>
      ) : (
        <ul className="space-y-1">
          {uploads.map((u) => {
            const href = downloadUrlFor(u.filename)
            const isPending = pendingDelete === u.filename
            const onDelete = async () => {
              setPendingDelete(u.filename)
              try {
                await deleteUpload(u.filename)
              } finally {
                setPendingDelete(null)
              }
            }
            const inner = (
              <>
                <FileText className="h-3 w-3 shrink-0" />
                <span className="truncate">{u.filename}</span>
                <span className="ml-auto text-[9px] text-white/30">{formatBytes(u.size)}</span>
              </>
            )
            return (
              <li
                key={u.filename}
                className="group flex items-stretch gap-1 rounded border border-white/10 bg-white/5 transition-colors hover:border-t-accent-alt/40"
              >
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="flex flex-1 items-center gap-2 px-2 py-1 text-[10px] text-white/70 transition-colors hover:text-t-accent-alt"
                    title={`${u.filename} (${u.size} bytes)`}
                  >
                    {inner}
                  </a>
                ) : (
                  <span className="flex flex-1 items-center gap-2 px-2 py-1 text-[10px] text-white/70">
                    {inner}
                  </span>
                )}
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={isPending}
                  aria-label={`Remove ${u.filename}`}
                  title={`Remove ${u.filename}`}
                  className="flex shrink-0 items-center justify-center px-1.5 text-white/30 transition-colors hover:text-red-400 disabled:opacity-50"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function SkillsList() {
  const { skills, session } = useHarnessSession()
  if (!session) {
    return <p className="text-[10px] text-white/30 px-1">Connect to load skills.</p>
  }
  if (skills.length === 0) {
    return <p className="text-[10px] text-white/30 px-1">No skills loaded.</p>
  }
  return (
    <ul className="space-y-2">
      {skills.map((s) => (
        <li key={s.name} className="rounded border border-white/10 px-2 py-1.5">
          <p className="font-mono text-[11px] text-t-accent-alt">{s.name}</p>
          <p className="mt-0.5 text-[10px] leading-snug text-white/55">{s.description}</p>
        </li>
      ))}
    </ul>
  )
}
