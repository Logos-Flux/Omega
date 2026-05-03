// Profile — schema-validated user profile + propose/accept/reject queue.
//
// Roadmap II.A.1. This commit lands ONLY the schema, the read/write
// primitives, and the propose-and-confirm queue. The `update_profile`
// tool (II.A.2) and the assembler wire-up (II.A.3) come in separate
// commits.
//
// Design references:
//   - AGENT_ARCHITECTURE.md L444-498 — schema-first profile, the
//     example shape (canonical), and the propose-not-commit rule:
//     "Profile writes are always confirmation-gated."
//   - ROADMAP.md II.A.1 — "queues a pending change for user
//     confirmation"; the example error string from L408-410:
//     "field 'X.Y' is not in the profile schema".
//
// Storage:
//   - /workspace/profile.json — committed truth, validated on every
//     write. Workspace boot seeds it as `{}` (src/workspace.ts).
//   - /workspace/profile.proposals.json — pending agent-suggested
//     edits awaiting user confirmation. Owned by this module; absent
//     until the first proposal is enqueued.
//
// Atomicity: writes go via a sibling tmpfile + rename. fs.rename on
// the same filesystem is atomic on Linux (the sprite mounts ext4 at
// /workspace), so a crash mid-write leaves either the old file or the
// fully-written new one — never a half-written profile.
//
// The propose-and-confirm shape established here is what V (preferences)
// and VI (memory writes) will reuse. Profiles are the strictest case:
// every agent-originated write is confirmation-gated regardless of
// auto_commit settings (per AGENT_ARCHITECTURE.md L498).

import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'

// Read WORKSPACE_ROOT lazily so test files can set it before importing
// — same pattern as src/workspace.ts.
function workspaceRoot(): string {
  return process.env.WORKSPACE_ROOT ?? '/workspace'
}

function profilePath(): string {
  return join(workspaceRoot(), 'profile.json')
}

function proposalsPath(): string {
  return join(workspaceRoot(), 'profile.proposals.json')
}

// ---
// Schema. Canonical shape per AGENT_ARCHITECTURE.md L451-473. No field
// is required at the top level (workspace ships profile.json as `{}`
// per Phase I.C and the user fills it in over time). `.strict()`
// rejects unknown top-level keys so the agent can't sneak fields past
// the schema.
// ---

const CommunicationSchema = z
  .object({
    tone_default: z.enum(['direct', 'warm', 'formal', 'casual']).optional(),
    format_preference: z.enum(['prose', 'bullets', 'mixed']).optional(),
    emoji: z.enum(['never', 'sparingly', 'often']).optional(),
    length_preference: z.enum(['short', 'medium', 'long']).optional(),
  })
  .strict()

const WorkSchema = z
  .object({
    company: z.string().optional(),
    role: z.string().optional(),
    domains: z.array(z.string()).optional(),
  })
  .strict()

const PersonalSchema = z
  .object({
    location: z.string().optional(),
    interests: z.array(z.string()).optional(),
  })
  .strict()

export const ProfileSchema = z
  .object({
    name: z.string().optional(),
    preferred_name: z.string().optional(),
    timezone: z.string().optional(), // IANA TZ
    locale: z.string().optional(), // BCP 47
    communication: CommunicationSchema.optional(),
    work: WorkSchema.optional(),
    personal: PersonalSchema.optional(),
  })
  .strict()

export type Profile = z.infer<typeof ProfileSchema>

// ---
// ProfileValidationError — thrown by writeProfile() and
// proposeProfileChange() with a human-readable, field-path message.
// Distinct error class so callers (the upcoming HTTP layer in II.A.2)
// can map it to a 400 instead of a 500.
// ---
export class ProfileValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileValidationError'
  }
}

// ---
// Schema introspection — derive the set of valid dot-paths from the
// zod schema itself rather than maintaining a parallel list. Keeps the
// schema as the single source of truth; a future field addition just
// works without touching this code.
//
// Returns the field-level zod schema for a given dot-path, or null if
// the path is not a leaf (or doesn't exist). Strips outer Optional
// wrappers so callers can call `.safeParse(value)` directly on the
// result.
// ---
function unwrapOptional(schema: z.ZodTypeAny): z.ZodTypeAny {
  let s: z.ZodTypeAny = schema
  // ZodOptional has .unwrap(); ZodNullable too. Walk both.
  while (
    typeof (s as { unwrap?: () => z.ZodTypeAny }).unwrap === 'function' &&
    (s.constructor.name === 'ZodOptional' ||
      s.constructor.name === 'ZodNullable')
  ) {
    s = (s as unknown as { unwrap: () => z.ZodTypeAny }).unwrap()
  }
  return s
}

/**
 * Resolve a dot-path against the schema. Returns the leaf field
 * schema, or null if the path is unknown. Path components must
 * traverse object schemas; descending into a non-object (string,
 * enum, array) returns null.
 */
function resolveFieldPath(path: string): z.ZodTypeAny | null {
  if (!path) return null
  const parts = path.split('.')
  let current: z.ZodTypeAny = ProfileSchema
  for (const part of parts) {
    const unwrapped = unwrapOptional(current)
    // Must be a ZodObject to descend.
    const shape = (unwrapped as unknown as { shape?: Record<string, z.ZodTypeAny> })
      .shape
    if (!shape || typeof shape !== 'object') return null
    if (!Object.prototype.hasOwnProperty.call(shape, part)) return null
    current = shape[part]
  }
  return unwrapOptional(current)
}

function formatZodIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((iss) => {
      const path = iss.path.length > 0 ? iss.path.join('.') : '<root>'
      return `${path}: ${iss.message}`
    })
    .join('; ')
}

// ---
// Atomic write helper. Write-then-rename so concurrent readers never
// see a half-flushed file.
// ---
async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  const contents = JSON.stringify(data, null, 2) + '\n'
  await writeFile(tmp, contents, 'utf8')
  await rename(tmp, path)
}

// ---
// readProfile — defensively returns `{}` on missing or invalid file.
// Workspace boot writes `{}` so the missing case shouldn't occur in
// practice, but be tolerant: a corrupt file blocking the entire
// harness would be worse than serving `{}` to the assembler.
// ---
export async function readProfile(): Promise<Profile> {
  const path = profilePath()
  if (!existsSync(path)) return {}
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return {}
  }
  if (raw.trim().length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  const result = ProfileSchema.safeParse(parsed)
  if (!result.success) return {}
  return result.data
}

// ---
// writeProfile — validates against the schema, then atomic-writes.
// Throws ProfileValidationError with a field-path message on invalid
// input.
// ---
export async function writeProfile(profile: Profile): Promise<void> {
  const result = ProfileSchema.safeParse(profile)
  if (!result.success) {
    throw new ProfileValidationError(
      `invalid profile: ${formatZodIssues(result.error.issues)}`,
    )
  }
  await atomicWriteJson(profilePath(), result.data)
}

// ---
// Proposal queue. Stored at /workspace/profile.proposals.json. Absent
// until the first proposal lands; readProposalsFile tolerates absence.
// ---

export interface ProfileProposal {
  id: string
  field: string
  value: unknown
  proposed_at: string
  proposed_by: 'agent' | 'user'
}

interface ProposalsFile {
  proposals: ProfileProposal[]
}

const ProposalsFileSchema = z.object({
  proposals: z.array(
    z.object({
      id: z.string(),
      field: z.string(),
      value: z.unknown(),
      proposed_at: z.string(),
      proposed_by: z.enum(['agent', 'user']),
    }),
  ),
})

async function readProposalsFile(): Promise<ProposalsFile> {
  const path = proposalsPath()
  if (!existsSync(path)) return { proposals: [] }
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return { proposals: [] }
  }
  if (raw.trim().length === 0) return { proposals: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { proposals: [] }
  }
  const result = ProposalsFileSchema.safeParse(parsed)
  if (!result.success) return { proposals: [] }
  return result.data
}

async function writeProposalsFile(file: ProposalsFile): Promise<void> {
  await atomicWriteJson(proposalsPath(), file)
}

/**
 * Validate a proposed (field, value) pair against the schema. Throws
 * ProfileValidationError with the canonical message on failure.
 */
function validateFieldChange(field: string, value: unknown): void {
  const fieldSchema = resolveFieldPath(field)
  if (fieldSchema === null) {
    throw new ProfileValidationError(
      `field '${field}' is not in the profile schema`,
    )
  }
  const result = fieldSchema.safeParse(value)
  if (!result.success) {
    throw new ProfileValidationError(
      `invalid value for '${field}': ${formatZodIssues(result.error.issues)}`,
    )
  }
}

/**
 * Apply a dot-path write to a profile object, returning a new object.
 * Creates intermediate objects as needed. The result is then validated
 * against the full ProfileSchema by the caller before persisting.
 */
function setDotPath(
  profile: Profile,
  field: string,
  value: unknown,
): Profile {
  const parts = field.split('.')
  // Shallow clone the spine we touch. Anything we don't touch is
  // shared with the input — fine because we don't mutate elsewhere.
  const next: Record<string, unknown> = { ...profile }
  let cursor: Record<string, unknown> = next
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!
    const existing = cursor[key]
    const nestedSource =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {}
    const nested: Record<string, unknown> = { ...nestedSource }
    cursor[key] = nested
    cursor = nested
  }
  cursor[parts[parts.length - 1]!] = value
  return next as Profile
}

/**
 * Enqueue a proposed profile change. Validates the field path and
 * value against the schema; on success appends to the proposals queue
 * and returns the new proposal id. Does NOT modify profile.json.
 */
export async function proposeProfileChange(
  field: string,
  value: unknown,
  proposedBy: 'agent' | 'user',
): Promise<{ proposalId: string }> {
  validateFieldChange(field, value)
  const file = await readProposalsFile()
  const proposal: ProfileProposal = {
    id: randomUUID(),
    field,
    value,
    proposed_at: new Date().toISOString(),
    proposed_by: proposedBy,
  }
  file.proposals.push(proposal)
  await writeProposalsFile(file)
  return { proposalId: proposal.id }
}

/**
 * Accept a queued proposal: apply the dot-path change to profile.json
 * and remove the entry from the queue. Throws if the id is unknown
 * (e.g. already accepted/rejected, or never existed).
 */
export async function acceptProfileProposal(proposalId: string): Promise<void> {
  const file = await readProposalsFile()
  const idx = file.proposals.findIndex((p) => p.id === proposalId)
  if (idx === -1) {
    throw new ProfileValidationError(
      `proposal '${proposalId}' not found`,
    )
  }
  const proposal = file.proposals[idx]!
  // Re-validate at acceptance time. The schema could in principle have
  // changed since the proposal was enqueued; surfacing the error here
  // is cleaner than writing a now-invalid value.
  validateFieldChange(proposal.field, proposal.value)
  const current = await readProfile()
  const updated = setDotPath(current, proposal.field, proposal.value)
  // Full-document validation catches any cross-field issues that
  // field-level validation can't see (none today, but cheap insurance).
  const result = ProfileSchema.safeParse(updated)
  if (!result.success) {
    throw new ProfileValidationError(
      `applying proposal '${proposalId}' produced an invalid profile: ${formatZodIssues(result.error.issues)}`,
    )
  }
  await atomicWriteJson(profilePath(), result.data)
  file.proposals.splice(idx, 1)
  await writeProposalsFile(file)
}

/**
 * Reject a queued proposal: remove it from the queue without touching
 * profile.json. Throws if the id is unknown — the caller (the HTTP
 * layer in II.A.2) needs to distinguish "rejected" from "never
 * existed" for accurate audit logging.
 */
export async function rejectProfileProposal(proposalId: string): Promise<void> {
  const file = await readProposalsFile()
  const idx = file.proposals.findIndex((p) => p.id === proposalId)
  if (idx === -1) {
    throw new ProfileValidationError(
      `proposal '${proposalId}' not found`,
    )
  }
  file.proposals.splice(idx, 1)
  await writeProposalsFile(file)
}

/**
 * List all pending proposals. Used by the
 * `GET /profile/proposals` endpoint that lands in II.A.2.
 */
export async function listProfileProposals(): Promise<ProfileProposal[]> {
  const file = await readProposalsFile()
  return file.proposals
}
