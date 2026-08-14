// `/workspace/state.json` — small, per-sprite (⇒ per-user) mutable state
// that isn't a registry entry, a profile field, or memory. Two consumers
// today:
//   - `activePersona` — which persona body fills assembler slot 5
//     (read by dispatcher.ts on every turn; written by the persona-select
//     route).
//   - `disabledSkills` — flat per-user skill toggle (read by the assembler
//     to filter the slot-8 catalog + guard read_skill; written by the
//     skill-toggle route).
//
// Both were previously either inline (`dispatcher.ts` parsed the file by
// hand) or non-existent. Centralizing here keeps the on-disk shape in one
// place and gives writers an atomic tmp-rename so a crash mid-write can't
// leave a half-truncated state.json (mirrors memory.ts::truncateConversationAt).
//
// Reads are forgiving: a missing file, malformed JSON, or a missing field
// resolves to the default rather than throwing — state.json is convenience
// state, never a hard dependency, and the dispatcher in particular must
// never be taken down by a bad file.

import { readFile, writeFile, rename } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceRoot } from './memory'

export interface HarnessState {
  /** Active persona name → assembler slot 5 body. */
  activePersona: string
  /** Skill names the user has switched off → filtered from slot 8 + read_skill. */
  disabledSkills: string[]
}

export const DEFAULT_STATE: HarnessState = {
  activePersona: 'default',
  disabledSkills: [],
}

function statePath(): string {
  return join(workspaceRoot(), 'state.json')
}

function coerce(raw: unknown): HarnessState {
  const obj = (raw ?? {}) as Record<string, unknown>
  const activePersona =
    typeof obj.activePersona === 'string' && obj.activePersona.length > 0
      ? obj.activePersona
      : DEFAULT_STATE.activePersona
  const disabledSkills = Array.isArray(obj.disabledSkills)
    ? obj.disabledSkills.filter((s): s is string => typeof s === 'string')
    : []
  return { activePersona, disabledSkills }
}

/** Async read for route handlers. Never throws — bad file ⇒ defaults. */
export async function readState(): Promise<HarnessState> {
  try {
    return coerce(JSON.parse(await readFile(statePath(), 'utf8')))
  } catch {
    return { ...DEFAULT_STATE }
  }
}

/**
 * Synchronous read for the dispatcher's hot path, which is sync-only by
 * design (an async hop there would force every caller async). state.json
 * is a few bytes; the read is negligible. Never throws.
 */
export function readStateSync(): HarnessState {
  try {
    if (!existsSync(statePath())) return { ...DEFAULT_STATE }
    return coerce(JSON.parse(readFileSync(statePath(), 'utf8')))
  } catch {
    return { ...DEFAULT_STATE }
  }
}

/** Atomic full write (tmp + rename). */
export async function writeState(state: HarnessState): Promise<void> {
  const path = statePath()
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  await rename(tmp, path)
}

/** Read-modify-write a subset of fields. Returns the resulting state. */
export async function patchState(partial: Partial<HarnessState>): Promise<HarnessState> {
  const next = { ...(await readState()), ...partial }
  await writeState(next)
  return next
}
