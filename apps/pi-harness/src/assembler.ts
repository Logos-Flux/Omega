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
import { listUploads, readUpload, writeUploadText } from './uploads'
import { EXEC_ALLOWLIST, runExec } from './exec'
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
function buildOperatorPolicy(provider: ProviderId, now: Date): string {
  const today = now.toISOString().slice(0, 10)
  const searchToolName =
    provider === 'anthropic'
      ? 'web_search'
      : provider === 'google'
        ? 'google_search'
        : null
  const groundingHint = searchToolName
    ? ` For anything time-sensitive (weather, news, prices, current events, "what's the latest…"), call \`${searchToolName}\` to ground in live results — don't answer from memory.`
    : ''
  return `Today is ${today}.${groundingHint}`
}

// Slot 3 — User profile. Activated in Phase II.A.3.
//
// Reads /workspace/profile.json via the profile module (which validates
// against the zod schema and defensively returns `{}` on any read /
// parse / schema failure). When the profile is empty, returns null so
// the assembler skips slot 3 entirely — no inert `<user_profile>` block
// in the system message.
//
// Renders the populated profile as natural English the model can read,
// not a JSON dump. Each field is on its own line; absent fields are
// skipped silently. Wrapped in `<user_profile>…</user_profile>` so the
// model can recognise it as structured context.
async function readProfileSlot(): Promise<string | null> {
  const profile = await readProfile()
  return renderProfile(profile)
}

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

// Slot 8 — Skill catalog. Active in Phase I (unfiltered; persona
// filtering arrives in VI).
async function readSkillCatalog(): Promise<string | null> {
  const skills = await listSkills()
  return buildSkillsSystemMessage(skills)
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

function toolsForProvider(
  provider: ProviderId,
  sessionId: string,
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
        'Append (default) or replace the persistent memory file at /workspace/memory.md. The file is read on every subsequent request and injected as a system message, so anything you write here will shape future answers. Use append for incremental notes (decisions, user preferences, project state). Use replace only when the user explicitly asks to wipe or rewrite memory. Keep entries dated and short.',
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
  if (provider === 'anthropic') {
    tools.web_search = anthropicTools.tools.webSearch_20250305({ maxUses: 5 })
  }
  if (provider === 'google') {
    // Tool name MUST be `google_search` for Gemini to recognize it as the
    // server-side grounding tool. Args are empty — Gemini composes queries
    // from conversation context.
    tools.google_search = googleProvider.tools.googleSearch({})
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
      profile,
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
      readProfileSlot(), // 3 (operator policy is synchronous; computed below)
      readGlobalMemory(), // 4
      readPersonaBody(personaName), // 5
      readPersonaMemory(personaName), // 6
      readPreferencesSlot(), // 7
      readSkillCatalog(), // 8
      readSessionPins(sessionId), // 12
      readUploadsCatalog(sessionId), // 13
      readConversation(sessionId), // 14
    ])

    const operatorPolicy = buildOperatorPolicy(provider, now) // 2
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

    const tools = toolsForProvider(provider, sessionId)

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
