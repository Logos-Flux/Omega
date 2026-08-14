// The PromptAssembler — single source of truth for the canonical
// 15-slot injection order described in docs/AGENT_ARCHITECTURE.md
// (see the table at L187-203). Pure function: given an Invocation and
// the current workspace state, produce a RequestPayload.
//
// Phase I (this commit) wires all 15 slots in order. Slots 1, 4, 8, 13,
// 14, and 15 emit content; the rest read inert sources defensively and
// emit nothing. Subsequent phases activate one slot at a time without
// touching this file's structure — they just give a slot a real source.
//
// The assembler is the ONLY place that knows slot ordering. Everything
// else contributes to a slot; nothing else writes to system messages.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tool, type ModelMessage, type ToolSet } from 'ai'
import { stepCountIs } from 'ai'
import type { ProviderOptions } from '@ai-sdk/provider-utils'
import { anthropic as anthropicTools } from '@ai-sdk/anthropic'
import { google as googleProvider } from '@ai-sdk/google'
import { z } from 'zod'

import type { Invocation, RequestPayload } from './types'
import type { ProviderId } from './providers'
import { readConversation, workspaceRoot } from './memory'
import {
  buildSkillsSystemMessage,
  listSkills,
  readSkill,
} from './skills'
import { SoulRegistry } from './souls'
import { PersonaRegistry } from './personas'
import { readState } from './state'
import { writeSkill } from './skill-write'
import { listUploads, readUpload, writeUploadText } from './uploads'
import { EXEC_ALLOWLIST, runExec } from './exec'
import { runShell } from './shell'
import { isDriveEnabled, searchDrive, fetchFile, copyFile, addComment } from './drive'
import {
  isImageGenEnabled,
  generateImage,
  ASPECT_RATIOS,
  RENDERING_SPEEDS,
  MAGIC_PROMPT,
  STYLE_TYPES,
} from './image'
import {
  appendSystemMemory,
  writeSystemMemory,
} from './memory'
import {
  proposeProfileChange,
  readProfile,
  ProfileValidationError,
  type Profile,
} from './profile'
import { isRagEnabled, searchRag } from './lib/rag'

// ---
// Cache marker helpers. Slots 1–7 are the "stable prefix" — the bits
// that don't change from turn to turn. Marking them with provider-
// appropriate cache hints means Anthropic and Gemini can prefix-cache
// the whole prefix once the user is locked to a provider+model on a
// thread (see I.D for the lock-in piece).
//
// Anthropic: providerOptions.anthropic.cacheControl = { type: 'ephemeral' }
//   — read by @ai-sdk/anthropic at convert-time and translated into
//   the API's `cache_control` block. Up to four breakpoints per
//   request; we use one per active stable slot, well under the limit.
//
// Gemini: the @ai-sdk/google SDK does not expose a per-message cache
//   marker today. Gemini 2.5+ supports IMPLICIT prefix caching
//   automatically (any prefix shared across requests is cached without
//   opt-in) and EXPLICIT context caching via a separately-created
//   CachedContent resource referenced as `cachedContent: <name>` on
//   the request. Per-block hints are not in the AI SDK surface yet.
//   TODO: revisit when @ai-sdk/google grows a cacheControl-style
//   provider option. Tracking issue:
//   https://github.com/vercel/ai/issues — search "google cache_control".
//
// Perplexity: no cache support; no-op.
// ---
const ANTHROPIC_CACHE_OPTS: ProviderOptions = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
}

function cacheOpts(provider: ProviderId): ProviderOptions | undefined {
  if (provider === 'anthropic') return ANTHROPIC_CACHE_OPTS
  // google + perplexity: no per-message marker today.
  return undefined
}

function systemSlot(
  content: string,
  provider: ProviderId,
  cacheable: boolean,
): ModelMessage {
  const opts = cacheable ? cacheOpts(provider) : undefined
  if (opts) {
    return { role: 'system', content, providerOptions: opts }
  }
  return { role: 'system', content }
}

// ---
// Slot readers. Each one reads from its canonical source and returns
// the slot's contribution as a string, or null if the slot is inert /
// empty for this turn. Phase I has stubs for slots 2/3/5/6/7/9/10/11/12
// that always return null but document where the future content will
// come from.
// ---

// Slot 1 — Soul.
// Resolves through SoulRegistry: user copy at /workspace/soul.md wins
// over the golden at /home/sprite/soul.md. ensureWorkspace() copies
// the golden into /workspace/soul.md on first boot, so steady-state
// reads only ever hit the user file; the registry's baked fallback
// is the safety net for harness builds that boot before
// ensureWorkspace runs (or against a workspace that's been wiped).
async function readSoul(): Promise<string | null> {
  const soul = await SoulRegistry.get('default')
  return soul?.body ?? null
}

// Slot 2 — Operator policy.
// Architecturally inert in Phase I (the doc lists it as activating in
// future phases). However, the existing harness ships a small baked
// policy fragment — the date anchor + provider-specific grounding hint
// — that lived inline in chat.ts::buildModelMessages and must be
// preserved to keep behaviour identical. Treating it as the only
// Phase-I-active piece of slot 2 (rather than scattering it elsewhere)
// keeps the architecture honest: when richer operator policy lands in
// later phases, this fragment just becomes one of several entries.
// Format the calendar date as YYYY-MM-DD in the given IANA timezone, falling
// back to UTC when tz is absent or invalid. Date-only on purpose: this feeds
// the *cached* operator-policy slot, and a date changes at most once per day,
// so the cache prefix survives within a day. The precise wall-clock time lives
// in the volatile current-time slot (buildCurrentTime) so caching isn't busted
// every turn.
function formatDateInTz(now: Date, timezone?: string): string {
  if (!timezone) return now.toISOString().slice(0, 10)
  try {
    // en-CA renders as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now)
  } catch {
    return now.toISOString().slice(0, 10)
  }
}

// Volatile (NON-cached) current date + time, localized to the user's timezone
// when known. Kept out of the cached prefix because it changes every turn.
function buildCurrentTime(now: Date, timezone?: string): string {
  const tz = timezone || 'UTC'
  try {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(now)
    return `The current date and time is ${formatted} (${tz}).`
  } catch {
    return `The current date and time is ${now.toISOString()} (UTC).`
  }
}

function buildOperatorPolicy(provider: ProviderId, now: Date, timezone?: string): string {
  const today = formatDateInTz(now, timezone)
  const geminiFileSearch = provider === 'google' && isGeminiFileSearchEnabled()

  // Knowledge-base retrieval tool exposed this turn.
  const kbTool = geminiFileSearch ? 'file_search' : isRagEnabled() ? 'rag_search' : null
  // Live web/grounding tool. File Search is mutually exclusive with
  // google_search, so the Gemini File Search path has no web tool.
  const webTool =
    provider === 'anthropic'
      ? 'web_search'
      : provider === 'google' && !geminiFileSearch
        ? 'google_search'
        : null

  const groundingHint = webTool
    ? ` For anything time-sensitive (weather, news, prices, current events, "what's the latest…"), call \`${webTool}\` to ground in live results — don't answer from memory.`
    : ''

  // Retrieval policy — keeps the agent from autonomously fanning out across
  // the Drive/Gmail connectors (the `gdcli ls` / `gmcli search` thrash). Work
  // the sources in order and stop as soon as you can answer.
  const kbStep = kbTool
    ? `2. To ANSWER a question from the knowledge base, search it with \`${kbTool}\` — it returns chunked snippets (good for answering, NOT for whole documents).`
    : '2. (No knowledge-base search tool is configured this turn.)'
  const driveStep = isDriveEnabled()
    ? "3. For any work on an actual FILE — reading its full content, copying, reviewing, commenting — use the Drive TOOLS, never the `gdcli` skill (gdcli is My-Drive-only and CANNOT see the knowledge base / Shared Drives). `drive_search` finds files anywhere; `drive_fetch_file` returns the WHOLE document (use it instead of rag_search chunks whenever you need the full text); `drive_copy_file` copies a file into the user's Drive; `drive_comment` adds review notes. To review or mark up a document: drive_copy_file it into the user's Drive, drive_fetch_file the full content, then leave your findings as drive_comment comments on the copy — never edit the shared original. Do NOT read_skill gdcli for knowledge-base files."
    : null
  const webOption = webTool
    ? `, or (b) treat it as a general/web question (use \`${webTool}\`)`
    : ', or (b) treat it as a general-knowledge question'
  const askStep = `${driveStep ? '4' : '3'}. If it's still not found, do NOT keep searching on your own. STOP and ask how to proceed — offer to (a) search their personal Google Drive (\`gdcli\`, My Drive) or Gmail (\`gmcli\`)${webOption}. It may not be about their internal files at all, so confirm first.`
  const policy = [
    '',
    '',
    "Retrieval policy — when a request involves the user's own materials, work through these in order and STOP as soon as you're done; do not exhaustively search:",
    '1. If the user uploaded files this session, check them first (`list_uploads`, then `read_upload`).',
    kbStep,
    ...(driveStep ? [driveStep] : []),
    askStep,
    "Never run the `gdcli` (Drive) or `gmcli` (Gmail) connectors to sweep the user's personal account unless they asked, or you asked and they agreed.",
  ].join('\n')

  return `Today is ${today}.${groundingHint}${policy}`
}

// Slot 3 — User profile. Activated in Phase II.A.3.
//
// Read raw via readProfile() (validates against the zod schema and
// defensively returns `{}` on any read / parse / schema failure) in build()'s
// Promise.all, then rendered with renderProfile() below. build() reads the raw
// profile (not a pre-rendered string) because it also needs profile.timezone
// as the fallback timezone for the date/time slots.
//
// renderProfile renders the populated profile as natural English the model can
// read, not a JSON dump. Each field is on its own line; absent fields are
// skipped silently. Wrapped in `<user_profile>…</user_profile>` so the
// model can recognise it as structured context.

/**
 * Render a Profile as a `<user_profile>` block, or null if the profile
 * has no populated fields. Exported for snapshot-test fixture authoring
 * and for unit-level coverage.
 */
export function renderProfile(profile: Profile): string | null {
  const lines: string[] = []

  if (profile.name) lines.push(`Name: ${profile.name}`)
  if (profile.preferred_name) lines.push(`Preferred name: ${profile.preferred_name}`)
  if (profile.timezone) lines.push(`Timezone: ${profile.timezone}`)
  if (profile.locale) lines.push(`Locale: ${profile.locale}`)

  const comm = profile.communication
  if (comm) {
    const parts: string[] = []
    if (comm.tone_default) parts.push(`${comm.tone_default} tone`)
    if (comm.format_preference) parts.push(`${comm.format_preference} format`)
    if (comm.emoji) parts.push(`emoji ${comm.emoji}`)
    if (comm.length_preference) parts.push(`${comm.length_preference} length`)
    if (parts.length > 0) lines.push(`Communication: ${parts.join(', ')}`)
  }

  const work = profile.work
  if (work) {
    const bits: string[] = []
    if (work.role && work.company) bits.push(`${work.role} at ${work.company}`)
    else if (work.role) bits.push(work.role)
    else if (work.company) bits.push(work.company)
    if (work.domains && work.domains.length > 0) {
      bits.push(`domains: ${work.domains.join(', ')}`)
    }
    if (bits.length > 0) lines.push(`Work: ${bits.join('; ')}`)
  }

  const personal = profile.personal
  if (personal) {
    const bits: string[] = []
    if (personal.location) bits.push(personal.location)
    if (personal.interests && personal.interests.length > 0) {
      bits.push(`interests: ${personal.interests.join(', ')}`)
    }
    if (bits.length > 0) lines.push(`Personal: ${bits.join('; ')}`)
  }

  if (lines.length === 0) return null

  return ['<user_profile>', ...lines, '</user_profile>'].join('\n')
}

// Slot 4 — Global memory.
// Canonical path: /workspace/memory/_global.md. The legacy
// /workspace/memory.md fallback was retired with I.C — the migration
// at workspace-boot time moves the legacy file into place before any
// request is served, so a single read is sufficient and keeps slot 4
// from doing double-disk-IO on every turn.
async function readGlobalMemory(): Promise<string | null> {
  const path = join(workspaceRoot(), 'memory', '_global.md')
  try {
    const text = await readFile(path, 'utf8')
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

// Slot 5 — Persona body.
// Resolved through PersonaRegistry. Phase I serves a single "default"
// persona (baked at /home/sprite/personas/default/persona.md) whose
// body is empty by design — the slot's plumbing is wired now so
// activating richer personas in Phase VI just means dropping more
// directories and giving them non-empty bodies. Returns null when the
// persona is missing or its body is empty so the assembler skips the
// system message entirely (unchanged behaviour vs. Phase I.A).
async function readPersonaBody(personaName: string): Promise<string | null> {
  const persona = await PersonaRegistry.get(personaName)
  if (!persona) return null
  const body = persona.body.trim()
  return body.length > 0 ? body : null
}

// Slot 6 — Persona memory. Inert in Phase I (activates in VI).
async function readPersonaMemory(_personaName: string): Promise<string | null> {
  return null
}

// Slot 7 — Preferences. Inert in Phase I (activates in V).
async function readPreferencesSlot(): Promise<string | null> {
  return null
}

// Slot 8 — Skill catalog. Filtered by the user's flat skill toggle
// (state.json::disabledSkills): a skill switched off in Settings is
// removed from the catalog so the model never sees it as available.
// (This is the standalone per-user toggle, independent of persona
// skill allow-lists, which remain inert.)
async function readSkillCatalog(): Promise<string | null> {
  const [skills, { disabledSkills }] = await Promise.all([listSkills(), readState()])
  const disabled = new Set(disabledSkills)
  return buildSkillsSystemMessage(skills.filter((s) => !disabled.has(s.name)))
}

// Slot 9 — KB hits. Lazy via tool, never injected here. Activates in IV.
// Slot 10 — Episodic hits. Lazy via tool, never injected here. Activates in VII.
// Slot 11 — Trigger payload. Only non-user invocations carry one.
// Activates in VIII (schedule + event) / IX (agent).
function readTriggerPayloadSlot(invocation: Invocation): string | null {
  if (invocation.trigger === 'user') return null
  // Future phases will format the payload appropriately. Phase I never
  // reaches here because the dispatcher refuses non-user triggers.
  return null
}

// Slot 12 — Session pins. Inert in Phase I (no UI to set them yet).
async function readSessionPins(_sessionId: string): Promise<string | null> {
  return null
}

// Slot 13 — Uploads catalog. Active in Phase I (existing behaviour).
async function readUploadsCatalog(sessionId: string): Promise<string | null> {
  const uploads = await listUploads(sessionId)
  if (uploads.length === 0) return null
  const lines = uploads.map(
    (u) => `  <file name="${u.filename}" bytes="${u.size}"/>`,
  )
  return [
    'Files the user uploaded to this session. Call read_upload(filename)',
    'to fetch the contents when relevant.',
    '',
    '<uploads>',
    ...lines,
    '</uploads>',
  ].join('\n')
}

// ---
// Tool set construction. Lifted verbatim from chat.ts::toolsForProvider
// — no behaviour changes. Lives in the assembler because tools are
// part of the assembled RequestPayload.
// ---

// Gemini File Search — when GEMINI_FILE_SEARCH_STORE is set (a
// `fileSearchStores/<id>` resource name owned by GOOGLE_API_KEY's project),
// the Gemini agent retrieves from that managed store via the native
// file_search tool instead of RAGFlow's rag_search. Mirrors chat-api's
// providers.ts so plain-chat and Agent Mode behave the same. File Search is
// mutually exclusive with google_search, so that grounding tool is dropped on
// this path (file_search still coexists with our custom function tools).
function geminiFileSearchStore(): string {
  return process.env.GEMINI_FILE_SEARCH_STORE?.trim() ?? ''
}
function isGeminiFileSearchEnabled(): boolean {
  return geminiFileSearchStore().length > 0
}

function toolsForProvider(
  provider: ProviderId,
  sessionId: string,
  userId: string,
): ToolSet | undefined {
  if (provider === 'perplexity') return undefined
  const tools: Record<string, unknown> = {
    read_skill: tool({
      description:
        'Load the full SKILL.md body for one of the available_skills listed in the system prompt. Returns the markdown text. Call this when the current task matches a skill description and you need the detailed instructions.',
      inputSchema: z.object({
        name: z.string().describe('The skill name from <available_skills>.'),
      }),
      execute: async ({ name }) => {
        // Guard the toggle: a skill the user switched off is absent from
        // the slot-8 catalog, so refuse to load it here too — otherwise a
        // model that remembers the name from history could bypass the
        // toggle.
        const { disabledSkills } = await readState()
        if (disabledSkills.includes(name)) {
          return { error: `skill disabled by the user: ${name}` }
        }
        const body = await readSkill(name)
        if (!body) return { error: `unknown skill: ${name}` }
        return { skill: name, body }
      },
    }),
    list_uploads: tool({
      description:
        'List files the user has uploaded to this session. Returns filename + size for each. Call this when the user mentions an attachment, paste, or asks about files they sent.',
      inputSchema: z.object({}),
      execute: async () => {
        const items = await listUploads(sessionId)
        return { uploads: items }
      },
    }),
    read_upload: tool({
      description:
        'Read the text content of a previously-uploaded file by filename. Use list_uploads first to see what is available. Only text-like files (md, txt, json, csv, code) up to ~1 MB.',
      inputSchema: z.object({
        filename: z.string().describe('The filename as shown by list_uploads.'),
      }),
      execute: async ({ filename }) => {
        const body = await readUpload(sessionId, filename)
        if (body === null) return { error: `not found or too large: ${filename}` }
        return { filename, body }
      },
    }),
    write_file: tool({
      description:
        'Save text (markdown, html, code, etc.) to a file in the session uploads directory. Use this before invoking exec to convert it (e.g. write a draft.md, then exec pandoc on it). The file becomes visible to the user and listable via list_uploads.',
      inputSchema: z.object({
        filename: z.string().describe('The basename, including extension. Path components stripped. e.g. "report.md".'),
        content: z.string().describe('The full text content to write. Cap 250 KB.'),
      }),
      execute: async ({ filename, content }) => {
        try {
          const info = await writeUploadText(sessionId, filename, content)
          return { ok: true, file: info }
        } catch (e) {
          return { error: (e as Error).message }
        }
      },
    }),
    write_skill: tool({
      description: [
        'Create or update a reusable skill — a packaged set of instructions for a recurring kind of task.',
        'Use this when you notice a task pattern the user repeats, or when the user asks you to "remember how to do X" / "make a skill for this".',
        'The skill is saved to the user\'s personal skill library and appears in <available_skills> on the next turn, loadable via read_skill.',
        'Follow the skill-creator skill for how to write a good name/description/body. After writing, call read_skill to verify it reads back correctly.',
      ].join(' '),
      inputSchema: z.object({
        name: z
          .string()
          .describe('Lowercase kebab-case identifier, 1–64 chars, e.g. "weekly-report". Becomes the skill name.'),
        description: z
          .string()
          .describe('One line. This is what the model (you, later) sees in <available_skills> to decide when to load the skill — make it a clear "activate when …" trigger.'),
        body: z
          .string()
          .describe('The full SKILL.md instructions in markdown (protocol, steps, voice). No frontmatter — it is generated from name + description.'),
      }),
      execute: async ({ name, description, body }) => {
        try {
          const result = await writeSkill({ name, description, body })
          return {
            ok: true,
            ...result,
            note: `Skill "${result.name}" ${result.overwritten ? 'updated' : 'created'}. Call read_skill("${result.name}") to verify.`,
          }
        } catch (e) {
          return { error: (e as Error).message }
        }
      },
    }),
    exec: tool({
      description: [
        "Run an allowlisted binary in this session's uploads directory and return its stdout/stderr/exit code.",
        `Allowlist: ${Array.from(EXEC_ALLOWLIST).join(', ')}.`,
        'Args are passed directly to the binary as separate argv entries — there is no shell.',
        "Use this when a skill's instructions tell you to invoke a binary on an uploaded file. The cwd is the user's uploads directory, so refer to uploaded files by filename only.",
        'Output is capped at 100KB per stream and the process is killed after 30s.',
      ].join(' '),
      inputSchema: z.object({
        command: z
          .string()
          .describe(`The binary name. Must be one of the allowlist.`),
        args: z
          .array(z.string())
          .describe(
            'Argument vector. Filenames should be the bare upload filename (no path).',
          ),
      }),
      execute: async ({ command, args }) => {
        try {
          const result = await runExec(command, args, sessionId)
          return result
        } catch (e) {
          return { error: (e as Error).message }
        }
      },
    }),
    update_profile: tool({
      description:
        'Propose a change to the user profile. The user must accept the proposal before it takes effect. Use this when the user shares a fact about themselves that fits the profile schema (name, location, work, communication preferences, etc.). The change is queued; do not say "I have updated your profile." — say "I have proposed updating your profile."',
      inputSchema: z.object({
        field: z
          .string()
          .describe(
            'Dot-path of the profile field, e.g. "personal.location" or "communication.tone_default".',
          ),
        value: z
          .unknown()
          .describe(
            'The proposed value for the field. Must match the schema type for that field.',
          ),
      }),
      execute: async ({ field, value }) => {
        try {
          const { proposalId } = await proposeProfileChange(field, value, 'agent')
          return { ok: true, proposalId, message: 'queued for confirmation' }
        } catch (err) {
          if (err instanceof ProfileValidationError) {
            return { ok: false, error: err.message }
          }
          throw err
        }
      },
    }),
    write_memory: tool({
      description:
        'Append (default) or replace the user\'s persistent memory. The memory is read on every subsequent request and injected as a system message, so anything you write here will shape future answers. Use append for incremental notes (decisions, user preferences, project state). Use replace only when the user explicitly asks to wipe or rewrite memory. The user can view and edit this memory in Settings, so keep entries dated, short, and legible.',
      inputSchema: z.object({
        text: z
          .string()
          .describe(
            'Markdown content to write. For append mode, prefix with a date heading like `## 2026-04-30` if a fresh entry is starting.',
          ),
        mode: z
          .enum(['append', 'replace'])
          .optional()
          .describe('Default "append".'),
      }),
      execute: async ({ text, mode }) => {
        const m = mode ?? 'append'
        if (m === 'replace') {
          await writeSystemMemory(text)
        } else {
          await appendSystemMemory(text)
        }
        return { ok: true, mode: m, bytesWritten: text.length }
      },
    }),
  }
  // shell — arbitrary `bash -lc` in the sprite's persistent /workspace. The
  // sprite container is the isolation boundary, so a real CLI is contained to
  // the user's own sandbox. Default-on; operators who don't want a shell set
  // HARNESS_SHELL_ENABLED=false on the controller's harness env.
  if (process.env.HARNESS_SHELL_ENABLED !== 'false') {
    tools.shell = tool({
      description: [
        'Run a shell command in this sprite via `bash -lc`. This is a real,',
        'persistent CLI: the working directory is /workspace and survives across',
        'turns, so clones, installs, and files you create stay around.',
        'Supports pipes, redirects, chaining, git, package managers, and code execution.',
        '',
        'Use this for: running scripts, git operations, installing/running tools,',
        'multi-step file processing — anything a terminal does.',
        'Prefer the dedicated tools when they fit: list_uploads/read_upload/write_file',
        'for simple file I/O, exec for the allowlisted document/connector binaries,',
        'rag_search for the user\'s indexed Drive content.',
        '',
        'Runs as the sprite user with a scrubbed environment (no harness secrets).',
        'Output is capped at 200 KB per stream and the command is killed after',
        '2 minutes — for long jobs, start them in the background and poll.',
      ].join(' '),
      inputSchema: z.object({
        command: z
          .string()
          .describe(
            'The command line to run, e.g. "git clone https://… && cd repo && ls -la". ' +
            'Runs through bash -lc with /workspace as the cwd.',
          ),
      }),
      execute: async ({ command }) => {
        try {
          const result = await runShell(command)
          return {
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            truncated: result.truncated,
            stdout: result.stdout || '(no output)',
            ...(result.stderr ? { stderr: result.stderr } : {}),
          }
        } catch (e) {
          return { error: (e as Error).message }
        }
      },
    })
  }
  // When Gemini File Search is active, the google path uses the native
  // file_search tool as its knowledge-base retrieval instead of RAGFlow's
  // rag_search (keeps Agent Mode consistent with plain chat).
  const geminiFileSearch = provider === 'google' && isGeminiFileSearchEnabled()

  // rag_search — registered only when both RAG_API_URL and
  // RAG_SERVICE_TOKEN are set on the harness env. Lets the model query
  // the user's indexed Drive content (per-user ACL applied server-side).
  if (isRagEnabled() && !geminiFileSearch) {
    tools.rag_search = tool({
      description: [
        "Search the user's indexed Drive content (their personal `my-ai/` folder plus any shared knowledge base) for chunks relevant to a query.",
        'Returns up to top_k snippets with file_name + source_url for citation.',
        'Use this when the user asks a question whose answer is likely in their own documents rather than general knowledge.',
        'Empty `chunks: []` is normal when nothing matches or the user has not synced any files yet — say so plainly rather than fabricating an answer.',
      ].join(' '),
      inputSchema: z.object({
        query: z
          .string()
          .describe('Natural-language question or keywords. The retriever does its own embedding + keyword hybrid; you do not need to format this for any specific search syntax.'),
        top_k: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Max chunks to return. Default 5. Raise to 10–15 for broad/exploratory questions.'),
      }),
      execute: async ({ query, top_k }) => {
        const result = await searchRag({ userId, query, topK: top_k })
        return result
      },
    })
  }
  // Shared-Drive-aware Drive access — registered when the controller can mint
  // the user's Google token. Unlike the gdcli connector (My-Drive only, can't
  // see Shared Drives), these reach the shared KB. Use them for a file's FULL
  // content or to copy a file, vs rag_search/file_search for chunked Q&A.
  if (isDriveEnabled()) {
    tools.drive_search = tool({
      description:
        'Find Google Drive files by name or content across My Drive AND all Shared Drives (including the shared knowledge base). Returns id, name, mimeType, link. Use this to locate a file before reading or copying it — the gdcli connector cannot see Shared Drives, so use this for anything in the KB.',
      inputSchema: z.object({
        query: z.string().describe('Words from the file name or its contents.'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10).'),
      }),
      execute: async ({ query, limit }) => {
        try {
          return { files: await searchDrive(userId, query, limit ?? 10) }
        } catch (e) {
          return { error: (e as Error).message }
        }
      },
    })
    tools.drive_fetch_file = tool({
      description:
        "Fetch the FULL content of a Drive file by id (Shared-Drive aware). Google Docs/Sheets/Slides come back as text inline; other files (PDF, docx, …) are saved to this session's uploads so you can read them with exec (pdftotext/pandoc). Use this when you need the whole document — not the chunked snippets from rag_search/file_search.",
      inputSchema: z.object({
        file_id: z.string().describe('The Drive file id (from a rag_search citation or a drive_search result).'),
      }),
      execute: async ({ file_id }) => {
        try {
          return await fetchFile(userId, file_id, sessionId)
        } catch (e) {
          return { error: (e as Error).message }
        }
      },
    })
    tools.drive_copy_file = tool({
      description:
        "Make a server-side copy of a Drive file (Shared-Drive aware), optionally renamed and/or placed in a target folder. Returns the new file id + link. Use this to copy a shared file into the user's own Drive — e.g. before reviewing/commenting so you don't touch the shared original.",
      inputSchema: z.object({
        file_id: z.string().describe('The Drive file id to copy.'),
        name: z.string().optional().describe('Name for the copy (defaults to "Copy of …").'),
        folder_id: z.string().optional().describe('Destination folder id (defaults to My Drive root).'),
      }),
      execute: async ({ file_id, name, folder_id }) => {
        try {
          return await copyFile(userId, file_id, name, folder_id)
        } catch (e) {
          return { error: (e as Error).message }
        }
      },
    })
    tools.drive_comment = tool({
      description:
        "Add a review comment to a Drive file (e.g. a Google Doc). Use this to leave suggestions/feedback the user can read and resolve — the closest thing to a tracked-change suggestion. Comment on a COPY in the user's Drive (drive_copy_file first), not the shared original. Unanchored, so reference the section in the comment text (e.g. 'Section 2 (IP assignment): …').",
      inputSchema: z.object({
        file_id: z.string().describe('The Drive file id to comment on (usually the copy you just made).'),
        content: z.string().describe('The comment text. Reference the relevant section/clause.'),
      }),
      execute: async ({ file_id, content }) => {
        try {
          return await addComment(userId, file_id, content)
        } catch (e) {
          return { error: (e as Error).message }
        }
      },
    })
  }
  // Image generation via Ideogram — registered only when IDEOGRAM_API_KEY is on
  // the harness env. Runs server-side in the harness (the exec sandbox can't
  // reach the API or hold the key) and saves each PNG into the session uploads,
  // so the user can view/download it. Driven by the `image-gen` skill.
  if (isImageGenEnabled()) {
    tools.generate_image = tool({
      description: [
        'Generate an image from a text prompt with Ideogram and save it to this session for the user.',
        'Use this when the user asks to create, draw, make, design, or generate a picture/image/logo/illustration/poster/icon.',
        'Ideogram renders legible text inside images well — good for logos, posters, mockups, signage.',
        'The image is saved to uploads (downloadable by the user, listed in list_uploads); you get back filenames, NOT pixels — never try to read the PNG bytes.',
        'Write a vivid, specific prompt (subject, style, composition, colors, lighting). Do not narrate the tool call.',
      ].join(' '),
      inputSchema: z.object({
        prompt: z
          .string()
          .describe('Vivid, specific description of the image. Include subject, style, composition, colors, mood. For text-in-image, quote the exact words to render.'),
        aspect_ratio: z
          .enum(ASPECT_RATIOS)
          .optional()
          .describe('Aspect ratio in WxH form (e.g. "1x1", "16x9", "9x16"). Default 1x1. NOTE the "x", not a colon.'),
        rendering_speed: z
          .enum(RENDERING_SPEEDS)
          .optional()
          .describe('FLASH (fastest, lowest quality) → TURBO → DEFAULT → QUALITY (slowest, best). Default DEFAULT. Use QUALITY when the user wants a polished final, FLASH for quick drafts.'),
        magic_prompt: z
          .enum(MAGIC_PROMPT)
          .optional()
          .describe('AUTO/ON/OFF — Ideogram\'s prompt-enhancer. ON enriches a short prompt; OFF renders your prompt verbatim (use OFF when the user gave exact wording or specific text to render).'),
        style_type: z
          .enum(STYLE_TYPES)
          .optional()
          .describe('AUTO, GENERAL, REALISTIC, DESIGN (logos/graphics/typography), or FICTION (illustration/concept-art).'),
        negative_prompt: z.string().optional().describe('What to avoid or exclude from the image.'),
        num_images: z
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .describe('How many variations to generate (default 1). Use 2–4 when the user wants options.'),
        seed: z.number().int().optional().describe('Fix the seed to reproduce or vary a prior result.'),
      }),
      execute: async (args) => {
        try {
          return await generateImage(args, sessionId)
        } catch (e) {
          return { error: (e as Error).message }
        }
      },
    })
  }
  if (provider === 'anthropic') {
    tools.web_search = anthropicTools.tools.webSearch_20250305({ maxUses: 5 })
  }
  if (provider === 'google') {
    if (geminiFileSearch) {
      // Native managed-RAG retrieval from the configured File Search store.
      // Mutually exclusive with google_search, so grounding is dropped here;
      // file_search coexists fine with our custom function tools.
      tools.file_search = googleProvider.tools.fileSearch({
        fileSearchStoreNames: [geminiFileSearchStore()],
      })
    } else {
      // Tool name MUST be `google_search` for Gemini to recognize it as the
      // server-side grounding tool. Args are empty — Gemini composes queries
      // from conversation context.
      tools.google_search = googleProvider.tools.googleSearch({})
    }
  }
  return tools as ToolSet
}

// ---
// Main entry: build a RequestPayload from an Invocation. Pure function;
// takes `now` so snapshot tests can pin wall-clock time.
// ---

export interface BuildOptions {
  now?: Date
}

export const PromptAssembler = {
  async build(invocation: Invocation, opts: BuildOptions = {}): Promise<RequestPayload> {
    const now = opts.now ?? new Date()
    const { provider, sessionId, prompt, personaName } = invocation

    // Pull every slot's contribution. Inert slots return null.
    const [
      soul,
      rawProfile,
      memory,
      personaBody,
      personaMemory,
      preferences,
      skillCatalog,
      sessionPins,
      uploadsCatalog,
      conversationLines,
    ] = await Promise.all([
      readSoul(), // 1
      readProfile(), // 3 raw — rendered below; also the timezone fallback source
      readGlobalMemory(), // 4
      readPersonaBody(personaName), // 5
      readPersonaMemory(personaName), // 6
      readPreferencesSlot(), // 7
      readSkillCatalog(), // 8
      readSessionPins(sessionId), // 12
      readUploadsCatalog(sessionId), // 13
      readConversation(sessionId), // 14
    ])

    // Slot 3 rendered + timezone precedence: explicit per-message tz wins
    // (handles travel without clobbering the manual profile field), then the
    // profile's saved tz, then UTC (handled downstream by the formatters).
    const profile = renderProfile(rawProfile)
    const timezone = invocation.timezone ?? rawProfile.timezone

    const operatorPolicy = buildOperatorPolicy(provider, now, timezone) // 2
    const currentTime = buildCurrentTime(now, timezone) // 2b (volatile)
    const triggerPayload = readTriggerPayloadSlot(invocation) // 11

    // Build system messages in canonical order. Slots 1–7 are the
    // stable prefix and get cache markers. Slots 8 (catalog) and 13
    // (uploads catalog) are session-stable but per-session-volatile —
    // do NOT mark them cacheable across sessions. Slot 11 (trigger
    // payload) and 12 (session pins) are turn-volatile.
    const systemMessages: ModelMessage[] = []

    // Slot 1 — Soul (cache).
    if (soul) {
      systemMessages.push(systemSlot(soul, provider, true))
    }

    // Slot 2 — Operator policy (cache). The harness-baked date +
    // grounding hint is the only Phase-I content; later phases extend.
    if (operatorPolicy) {
      systemMessages.push(systemSlot(operatorPolicy, provider, true))
    }

    // Slot 3 — User profile (cache). Inert in Phase I.
    if (profile) {
      systemMessages.push(systemSlot(profile, provider, true))
    }

    // Slot 4 — Global memory (cache).
    if (memory && memory.length > 0) {
      systemMessages.push(systemSlot(`Persistent memory:\n\n${memory}`, provider, true))
    }

    // Slot 5 — Persona body (cache). Inert in Phase I.
    if (personaBody) {
      systemMessages.push(systemSlot(personaBody, provider, true))
    }

    // Slot 6 — Persona memory (cache). Inert in Phase I.
    if (personaMemory) {
      systemMessages.push(systemSlot(personaMemory, provider, true))
    }

    // Slot 7 — Preferences (cache). Inert in Phase I.
    if (preferences) {
      systemMessages.push(systemSlot(preferences, provider, true))
    }

    // Slot 2b — Current date + time (NO cache; changes every turn). Placed
    // here, after the last cached slot, so the wall-clock time doesn't
    // invalidate the cached prefix above it.
    systemMessages.push(systemSlot(currentTime, provider, false))

    // Slot 8 — Skill catalog (no cache marker — varies as user adds
    // skills, kept out of the cache prefix).
    if (skillCatalog) {
      systemMessages.push(systemSlot(skillCatalog, provider, false))
    }

    // Slot 9 — KB hits. Lazy via tool; nothing to inject here.
    // Slot 10 — Episodic hits. Lazy via tool; nothing to inject here.

    // Slot 11 — Trigger payload (no cache; per-trigger volatile).
    if (triggerPayload) {
      systemMessages.push(systemSlot(triggerPayload, provider, false))
    }

    // Slot 12 — Session pins (no cache; per-turn volatile).
    if (sessionPins) {
      systemMessages.push(systemSlot(sessionPins, provider, false))
    }

    // Slot 13 — Uploads catalog (no cache; mutates as user uploads).
    if (uploadsCatalog) {
      systemMessages.push(systemSlot(uploadsCatalog, provider, false))
    }

    // Build conversation messages: history (slot 14) + latest user
    // turn (slot 15). Coalesce same-role adjacent lines, then append
    // the user's latest turn — same logic as the original
    // buildModelMessages, just on a fresh array (no system mixing).
    const modelMessages: ModelMessage[] = []
    for (const line of conversationLines) {
      const prev = modelMessages[modelMessages.length - 1]
      if (prev && prev.role === line.role && typeof prev.content === 'string') {
        prev.content += '\n\n' + line.text
      } else {
        modelMessages.push({ role: line.role, content: line.text })
      }
    }
    const last = modelMessages[modelMessages.length - 1]
    if (last && last.role === 'user' && typeof last.content === 'string') {
      last.content += '\n\n' + prompt
    } else {
      modelMessages.push({ role: 'user', content: prompt })
    }

    const tools = toolsForProvider(provider, sessionId, invocation.userId)

    return {
      systemMessages,
      tools,
      modelMessages,
      runtimeConfig: {
        stopWhen: tools ? stepCountIs(20) : undefined,
        budgetLimits: invocation.budget,
      },
      provider,
      model: invocation.model,
    }
  },
}
