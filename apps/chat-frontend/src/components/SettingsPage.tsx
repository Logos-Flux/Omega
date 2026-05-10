// II.B.1 + II.B.2 — Settings page. Mounts at /chat/settings via pathname
// switch in <App.tsx>. Sits inside the same auth + Google-OAuth gate as
// the chat surface, but does NOT mount the assistant-ui runtime — it
// talks to the harness HTTP directly via `harness-api.ts`.
//
// Structure:
//   - Left rail: section nav (Profile/Preferences/Persona/Quick Actions/
//     Connectors/Audit). Phase II only implements Profile; the rest
//     render placeholder text noting which Phase activates them.
//   - Right pane: active section content. The Profile pane includes the
//     proposals strip (top) + the editable profile form.
//
// Selection: URL hash (`#profile`, `#preferences`, …). Falls back to
// `profile` when the hash is missing or unrecognised. We use the hash
// (not local state) so the user can deep-link or refresh and land on
// the same section, and so the back button "feels right".

import { useCallback, useEffect, useState } from 'react'
import { AppShell, UserMenu } from '@omega-inc/app-shell'
import {
  acceptProposal,
  getProfile,
  listProposals,
  openSession,
  putProfile,
  rejectProposal,
  type HarnessSessionHandle,
  type Profile,
  type ProfileProposal,
} from '../lib/harness-api'
import { RAGSourceCard } from './RAGSourceCard'

// ---------- Section nav ---------------------------------------------------

type SectionId =
  | 'profile'
  | 'preferences'
  | 'persona'
  | 'quick-actions'
  | 'connectors'
  | 'audit'

const SECTIONS: ReadonlyArray<{
  id: SectionId
  label: string
  /** Phase that activates this section, for placeholder copy. */
  phase: string
  implemented: boolean
}> = [
  { id: 'profile', label: 'Profile', phase: 'Phase II', implemented: true },
  { id: 'preferences', label: 'Preferences', phase: 'Phase V', implemented: false },
  { id: 'persona', label: 'Persona', phase: 'Phase VI', implemented: false },
  { id: 'quick-actions', label: 'Quick Actions', phase: 'Phase III', implemented: false },
  { id: 'connectors', label: 'Connectors', phase: 'Phase IV', implemented: true },
  { id: 'audit', label: 'Audit', phase: 'Phase IX', implemented: false },
]

function readSectionFromHash(): SectionId {
  if (typeof window === 'undefined') return 'profile'
  const raw = window.location.hash.replace(/^#/, '')
  const found = SECTIONS.find((s) => s.id === raw)
  return found?.id ?? 'profile'
}

// ---------- Page entry point ---------------------------------------------

export function SettingsPage() {
  // Hash-driven section selection. We listen for hashchange so the
  // sidebar links can be plain `<a href="#…">` and feel native.
  const [section, setSection] = useState<SectionId>(() => readSectionFromHash())
  useEffect(() => {
    const onChange = () => setSection(readSectionFromHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  // Single shared session handle for every harness call on this page.
  // We open it lazily on first load and reuse across the form + the
  // proposals strip so we don't burn extra POSTs to the controller.
  const [session, setSession] = useState<HarnessSessionHandle | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    openSession()
      .then((s) => {
        if (!cancelled) setSession(s)
      })
      .catch((e: Error) => {
        if (!cancelled) setSessionError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <AppShell
      appId="chat"
      topNavEndSlot={<UserMenu settingsHref={`${import.meta.env.BASE_URL}settings`} />}
    >
      <div className="flex min-h-full bg-t-deep">
        <SectionNav active={section} session={session} />
        <main className="min-w-0 flex-1 overflow-y-auto p-8">
          <div className="mx-auto max-w-3xl">
            {sessionError && (
              <div className="mb-6 rounded border border-t-accent-alt/40 bg-t-accent-alt/5 px-4 py-3 text-sm text-t-accent-alt">
                Couldn't open session: {sessionError}
              </div>
            )}
            {section === 'profile' && <ProfileSection session={session} />}
            {section === 'connectors' && <ConnectorsSection />}
            {section !== 'profile' && section !== 'connectors' && (
              <StubSection sectionId={section} />
            )}
          </div>
        </main>
      </div>
    </AppShell>
  )
}

// ---------- Left rail -----------------------------------------------------

function SectionNav({
  active,
  session,
}: {
  active: SectionId
  session: HarnessSessionHandle | null
}) {
  // Only the Profile section gets a count badge today — it's the only
  // one with a backing API. Other sections will grow their own badges
  // in their respective phases.
  const [proposalCount, setProposalCount] = useState<number>(0)
  useEffect(() => {
    if (!session) return
    let cancelled = false
    listProposals(session)
      .then((list) => {
        if (!cancelled) setProposalCount(list.length)
      })
      .catch(() => {
        // Badge is best-effort — silently swallow; the Profile pane
        // will surface the real error if /proposals is broken.
      })
    return () => {
      cancelled = true
    }
  }, [session])

  return (
    <nav
      aria-label="Settings sections"
      className="w-56 shrink-0 border-r border-t-border bg-t-surface p-4"
    >
      <h2 className="mb-3 px-2 font-display text-xs uppercase tracking-[0.18em] text-t-muted">
        Settings
      </h2>
      <ul className="space-y-1">
        {SECTIONS.map((s) => {
          const isActive = s.id === active
          return (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                aria-current={isActive ? 'page' : undefined}
                className={[
                  'flex items-center justify-between rounded px-2 py-1.5 text-sm transition-colors',
                  isActive
                    ? 'bg-t-accent/10 text-t-bright'
                    : 'text-t-muted hover:bg-t-hover hover:text-t-bright',
                ].join(' ')}
              >
                <span>{s.label}</span>
                {s.id === 'profile' && proposalCount > 0 && (
                  <span
                    aria-label={`${proposalCount} pending proposal${proposalCount === 1 ? '' : 's'}`}
                    className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-t-accent-alt px-1.5 text-[10px] font-medium text-white"
                  >
                    {proposalCount}
                  </span>
                )}
                {!s.implemented && (
                  <span className="ml-2 text-[10px] uppercase tracking-wider text-t-muted/60">
                    Soon
                  </span>
                )}
              </a>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

// ---------- Stub sections -------------------------------------------------

function StubSection({ sectionId }: { sectionId: SectionId }) {
  const meta = SECTIONS.find((s) => s.id === sectionId)
  if (!meta) return null
  return (
    <section>
      <h1 className="mb-1 font-display text-2xl font-semibold text-t-bright">
        {meta.label}
      </h1>
      <p className="text-sm text-t-muted">Coming in {meta.phase}.</p>
    </section>
  )
}

// ---------- Connectors section --------------------------------------------
//
// Single concrete connector for now — the RAG ingest source. Drive vs
// filesystem mode is picked from the deploy's RAG_SOURCE env via
// /api/rag/source; the card adapts accordingly. Future connectors
// (Slack, Notion, Linear, etc.) drop in alongside.

function ConnectorsSection() {
  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-semibold text-t-bright">
          Connectors
        </h1>
        <p className="mt-1 text-sm text-t-muted">
          Wire external content into the assistant.
        </p>
      </header>
      <RAGSourceCard />
    </section>
  )
}

// ---------- Profile section ----------------------------------------------

interface FieldError {
  /** Dot-path of the offending field, e.g. `personal.location`. */
  field?: string
  message: string
}

function ProfileSection({ session }: { session: HarnessSessionHandle | null }) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [proposals, setProposals] = useState<ProfileProposal[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<FieldError | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const reload = useCallback(async () => {
    if (!session) return
    setLoading(true)
    setLoadError(null)
    try {
      const [p, ps] = await Promise.all([getProfile(session), listProposals(session)])
      setProfile(p)
      setProposals(ps)
    } catch (e) {
      setLoadError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [session])

  useEffect(() => {
    void reload()
  }, [reload])

  const onSave = useCallback(
    async (next: Profile) => {
      if (!session) return
      setSaving(true)
      setSaveError(null)
      setSavedAt(null)
      try {
        await putProfile(session, next)
        // Refetch to confirm the harness's persisted state matches what
        // we just sent — covers the case where the server normalises
        // values (e.g. trims whitespace).
        await reload()
        setSavedAt(Date.now())
      } catch (e) {
        const err = e as Error & { detail?: string }
        const detail = err.detail ?? err.message
        // Try to lift the field name out of harness-shaped error
        // messages like `field 'personal.location' is not in the
        // profile schema`.
        const m = /field '([^']+)'/.exec(detail)
        setSaveError({
          field: m?.[1],
          message: detail,
        })
      } finally {
        setSaving(false)
      }
    },
    [session, reload],
  )

  const onAccept = useCallback(
    async (id: string) => {
      if (!session) return
      try {
        await acceptProposal(session, id)
        await reload()
      } catch (e) {
        setSaveError({ message: (e as Error).message })
      }
    },
    [session, reload],
  )

  const onReject = useCallback(
    async (id: string) => {
      if (!session) return
      try {
        await rejectProposal(session, id)
        await reload()
      } catch (e) {
        setSaveError({ message: (e as Error).message })
      }
    },
    [session, reload],
  )

  return (
    <section>
      <header className="mb-6">
        <h1 className="mb-1 font-display text-2xl font-semibold text-t-bright">
          Profile
        </h1>
        <p className="text-sm text-t-muted">
          What the assistant knows about you. Every field is optional and editable.
        </p>
      </header>

      {!session && !loadError && (
        <p className="text-xs uppercase tracking-wider text-t-muted">
          Opening session…
        </p>
      )}

      {loadError && (
        <div className="mb-6 rounded border border-t-accent-alt/40 bg-t-accent-alt/5 px-4 py-3 text-sm text-t-accent-alt">
          Couldn't load profile: {loadError}
        </div>
      )}

      {proposals.length > 0 && (
        <ProposalsStrip
          proposals={proposals}
          onAccept={onAccept}
          onReject={onReject}
        />
      )}

      {loading && session && (
        <p className="text-xs uppercase tracking-wider text-t-muted">Loading profile…</p>
      )}

      {profile && !loading && (
        <ProfileForm
          initial={profile}
          saving={saving}
          saveError={saveError}
          savedAt={savedAt}
          onSubmit={onSave}
        />
      )}
    </section>
  )
}

// ---------- Proposals strip -----------------------------------------------

function ProposalsStrip({
  proposals,
  onAccept,
  onReject,
}: {
  proposals: ProfileProposal[]
  onAccept: (id: string) => void
  onReject: (id: string) => void
}) {
  return (
    <div className="mb-8 t-card p-4">
      <h2 className="mb-3 font-display text-sm uppercase tracking-[0.18em] text-t-accent">
        Agent suggested updates
      </h2>
      <ul className="space-y-3">
        {proposals.map((p) => (
          <li
            key={p.id}
            className="flex flex-col gap-3 rounded border border-t-border bg-t-surface p-3 sm:flex-row sm:items-start sm:justify-between"
          >
            <div className="min-w-0 flex-1">
              <div className="font-display text-sm text-t-bright">
                {humanizeFieldKey(p.field)}
              </div>
              <div className="mt-1 break-words text-sm text-t-muted">
                <span className="text-t-bright">{formatProposalValue(p.value)}</span>
              </div>
              {(p.reason || p.proposed_at) && (
                <div className="mt-1 text-[11px] uppercase tracking-wider text-t-muted/70">
                  {p.reason && <span>{p.reason}</span>}
                  {p.reason && p.proposed_at && <span> · </span>}
                  {p.proposed_at && <span>{formatTimeAgo(p.proposed_at)}</span>}
                </div>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => onAccept(p.id)}
                className="rounded border border-t-accent bg-t-accent/10 px-3 py-1.5 text-xs font-medium text-t-bright transition-colors hover:bg-t-accent/20"
              >
                Accept
              </button>
              <button
                type="button"
                onClick={() => onReject(p.id)}
                className="rounded border border-t-border bg-t-surface px-3 py-1.5 text-xs font-medium text-t-muted transition-colors hover:border-t-border-active hover:text-t-bright"
              >
                Reject
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function humanizeFieldKey(key: string): string {
  // `personal.location` → "Personal location"; `communication.tone_default` →
  // "Communication tone default". Best-effort — we keep it simple.
  const parts = key.split('.')
  const flat = parts.join(' ').replace(/_/g, ' ')
  if (!flat) return key
  return flat.charAt(0).toUpperCase() + flat.slice(1)
}

function formatProposalValue(v: unknown): string {
  if (v == null) return '—'
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function formatTimeAgo(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d ago`
}

// ---------- Profile form -------------------------------------------------

const TONE_OPTIONS = ['', 'direct', 'warm', 'formal', 'casual'] as const
const FORMAT_OPTIONS = ['', 'prose', 'bullets', 'mixed'] as const
const EMOJI_OPTIONS = ['', 'never', 'sparingly', 'often'] as const
const LENGTH_OPTIONS = ['', 'short', 'medium', 'long'] as const

interface FormState {
  name: string
  preferred_name: string
  timezone: string
  locale: string
  tone_default: string
  format_preference: string
  emoji: string
  length_preference: string
  company: string
  role: string
  domains: string // CSV — split on save
  location: string
  interests: string // CSV — split on save
}

function profileToForm(p: Profile): FormState {
  return {
    name: p.name ?? '',
    preferred_name: p.preferred_name ?? '',
    timezone: p.timezone ?? '',
    locale: p.locale ?? '',
    tone_default: p.communication?.tone_default ?? '',
    format_preference: p.communication?.format_preference ?? '',
    emoji: p.communication?.emoji ?? '',
    length_preference: p.communication?.length_preference ?? '',
    company: p.work?.company ?? '',
    role: p.work?.role ?? '',
    domains: (p.work?.domains ?? []).join(', '),
    location: p.personal?.location ?? '',
    interests: (p.personal?.interests ?? []).join(', '),
  }
}

function formToProfile(f: FormState): Profile {
  // Strip empty strings/arrays so we don't send `""` for fields the user
  // never touched. The harness schema treats absent and empty differently
  // for some fields (e.g. tone_default's enum doesn't include "").
  const trimList = (s: string): string[] =>
    s
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  const profile: Profile = {}
  if (f.name.trim()) profile.name = f.name.trim()
  if (f.preferred_name.trim()) profile.preferred_name = f.preferred_name.trim()
  if (f.timezone.trim()) profile.timezone = f.timezone.trim()
  if (f.locale.trim()) profile.locale = f.locale.trim()

  const comm: NonNullable<Profile['communication']> = {}
  if (f.tone_default) comm.tone_default = f.tone_default
  if (f.format_preference) comm.format_preference = f.format_preference
  if (f.emoji) comm.emoji = f.emoji
  if (f.length_preference) comm.length_preference = f.length_preference
  if (Object.keys(comm).length > 0) profile.communication = comm

  const work: NonNullable<Profile['work']> = {}
  if (f.company.trim()) work.company = f.company.trim()
  if (f.role.trim()) work.role = f.role.trim()
  const domains = trimList(f.domains)
  if (domains.length > 0) work.domains = domains
  if (Object.keys(work).length > 0) profile.work = work

  const personal: NonNullable<Profile['personal']> = {}
  if (f.location.trim()) personal.location = f.location.trim()
  const interests = trimList(f.interests)
  if (interests.length > 0) personal.interests = interests
  if (Object.keys(personal).length > 0) profile.personal = personal

  return profile
}

function ProfileForm({
  initial,
  saving,
  saveError,
  savedAt,
  onSubmit,
}: {
  initial: Profile
  saving: boolean
  saveError: FieldError | null
  savedAt: number | null
  onSubmit: (next: Profile) => void
}) {
  const [form, setForm] = useState<FormState>(() => profileToForm(initial))

  // Re-sync the form whenever `initial` changes (after a successful PUT
  // we refetch and pass the new profile down). Without this, the form
  // would stay stale after the harness normalises any of our values.
  useEffect(() => {
    setForm(profileToForm(initial))
  }, [initial])

  const set = <K extends keyof FormState>(key: K) => (value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit(formToProfile(form))
  }

  // Toast indicator: show "Saved" for ~2s after a successful save.
  const [showSaved, setShowSaved] = useState(false)
  useEffect(() => {
    if (savedAt == null) return
    setShowSaved(true)
    const t = window.setTimeout(() => setShowSaved(false), 2000)
    return () => window.clearTimeout(t)
  }, [savedAt])

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {saveError && !saveError.field && (
        <div className="rounded border border-t-accent-alt/40 bg-t-accent-alt/5 px-4 py-3 text-sm text-t-accent-alt">
          {saveError.message}
        </div>
      )}

      <FieldGroup title="Identity">
        <TextField
          label="Name"
          value={form.name}
          onChange={set('name')}
          fieldKey="name"
          error={saveError}
        />
        <TextField
          label="Preferred name"
          value={form.preferred_name}
          onChange={set('preferred_name')}
          fieldKey="preferred_name"
          error={saveError}
        />
        <TextField
          label="Timezone"
          placeholder="e.g., Europe/London"
          value={form.timezone}
          onChange={set('timezone')}
          fieldKey="timezone"
          error={saveError}
        />
        <TextField
          label="Locale"
          placeholder="e.g., en-GB"
          value={form.locale}
          onChange={set('locale')}
          fieldKey="locale"
          error={saveError}
        />
      </FieldGroup>

      <FieldGroup title="Communication">
        <SelectField
          label="Tone"
          options={TONE_OPTIONS}
          value={form.tone_default}
          onChange={set('tone_default')}
          fieldKey="communication.tone_default"
          error={saveError}
        />
        <SelectField
          label="Format preference"
          options={FORMAT_OPTIONS}
          value={form.format_preference}
          onChange={set('format_preference')}
          fieldKey="communication.format_preference"
          error={saveError}
        />
        <SelectField
          label="Emoji"
          options={EMOJI_OPTIONS}
          value={form.emoji}
          onChange={set('emoji')}
          fieldKey="communication.emoji"
          error={saveError}
        />
        <SelectField
          label="Length preference"
          options={LENGTH_OPTIONS}
          value={form.length_preference}
          onChange={set('length_preference')}
          fieldKey="communication.length_preference"
          error={saveError}
        />
      </FieldGroup>

      <FieldGroup title="Work">
        <TextField
          label="Company"
          value={form.company}
          onChange={set('company')}
          fieldKey="work.company"
          error={saveError}
        />
        <TextField
          label="Role"
          value={form.role}
          onChange={set('role')}
          fieldKey="work.role"
          error={saveError}
        />
        <TextField
          label="Domains"
          placeholder="e.g., mathematics, computing"
          help="Comma-separated."
          value={form.domains}
          onChange={set('domains')}
          fieldKey="work.domains"
          error={saveError}
          chips={form.domains}
        />
      </FieldGroup>

      <FieldGroup title="Personal">
        <TextField
          label="Location"
          placeholder="e.g., London, UK"
          value={form.location}
          onChange={set('location')}
          fieldKey="personal.location"
          error={saveError}
        />
        <TextField
          label="Interests"
          placeholder="e.g., mathematics, music, computing"
          help="Comma-separated."
          value={form.interests}
          onChange={set('interests')}
          fieldKey="personal.interests"
          error={saveError}
          chips={form.interests}
        />
      </FieldGroup>

      <div className="flex items-center justify-end gap-3 border-t border-t-border pt-4">
        {showSaved && (
          <span className="text-xs uppercase tracking-wider text-t-accent">Saved</span>
        )}
        <button
          type="submit"
          disabled={saving}
          className="rounded border border-t-accent bg-t-accent/10 px-4 py-2 text-sm font-medium text-t-bright transition-colors hover:bg-t-accent/20 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

function FieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-3 font-display text-xs uppercase tracking-[0.18em] text-t-muted">
        {title}
      </legend>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
    </fieldset>
  )
}

interface FieldProps {
  label: string
  value: string
  onChange: (next: string) => void
  fieldKey: string
  error: FieldError | null
  placeholder?: string
  help?: string
  /** Optional CSV string — when present, render a chip-list visualisation
   *  beneath the input so the user can see what they've entered. */
  chips?: string
}

function TextField({
  label,
  value,
  onChange,
  fieldKey,
  error,
  placeholder,
  help,
  chips,
}: FieldProps) {
  const isError = errorMatches(error, fieldKey)
  const chipList = chips
    ? chips
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : []
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-display text-xs uppercase tracking-wider text-t-muted">
        {label}
      </span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={[
          'rounded border bg-t-surface px-3 py-2 text-sm text-t-bright transition-colors',
          'focus:outline-none focus:ring-1 focus:ring-t-accent',
          isError ? 'border-t-accent-alt' : 'border-t-border focus:border-t-accent',
        ].join(' ')}
      />
      {help && <span className="text-[11px] text-t-muted/70">{help}</span>}
      {chipList.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {chipList.map((c) => (
            <span
              key={c}
              className="inline-flex items-center rounded-full border border-t-border bg-t-hover px-2 py-0.5 text-[11px] text-t-muted"
            >
              {c}
            </span>
          ))}
        </div>
      )}
      {isError && error && (
        <span className="text-[11px] text-t-accent-alt">{error.message}</span>
      )}
    </label>
  )
}

function SelectField({
  label,
  options,
  value,
  onChange,
  fieldKey,
  error,
}: {
  label: string
  options: ReadonlyArray<string>
  value: string
  onChange: (next: string) => void
  fieldKey: string
  error: FieldError | null
}) {
  const isError = errorMatches(error, fieldKey)
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-display text-xs uppercase tracking-wider text-t-muted">
        {label}
      </span>
      {/* DESIGN-SYSTEM GAP: app-shell doesn't ship a <Select /> primitive
          yet, so we drop down to a native <select> styled with Tailwind.
          When app-shell grows a Select, swap this and remove the styling. */}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={[
          'rounded border bg-t-surface px-3 py-2 text-sm text-t-bright transition-colors',
          'focus:outline-none focus:ring-1 focus:ring-t-accent',
          isError ? 'border-t-accent-alt' : 'border-t-border focus:border-t-accent',
        ].join(' ')}
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt === '' ? '—' : opt}
          </option>
        ))}
      </select>
      {isError && error && (
        <span className="text-[11px] text-t-accent-alt">{error.message}</span>
      )}
    </label>
  )
}

function errorMatches(error: FieldError | null, fieldKey: string): boolean {
  if (!error?.field) return false
  return error.field === fieldKey
}

// ---------- Path detection ------------------------------------------------

/** Exported so <App /> can decide whether to render <SettingsPage /> or
 *  the chat surface. Compares against `${BASE_URL}settings(/...)`. */
export function isSettingsPath(): boolean {
  if (typeof window === 'undefined') return false
  const base = import.meta.env.BASE_URL
  const path = window.location.pathname
  return path === `${base}settings` || path.startsWith(`${base}settings/`)
}

