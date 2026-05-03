import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { workspaceRoot } from './memory'
import type { RegistryEntry } from './lib/registry'

// SoulRegistry — the *who* of the agent. By design **one soul per
// user** (AGENT_ARCHITECTURE.md L88-92, ROADMAP.md L292-296). The
// registry pattern is reused so the baked-vs-user override mechanic
// stays consistent across the four registries, BUT souls live as a
// single file, not a directory of subdirectories:
//
//   /workspace/soul.md    — user copy. Created on first boot from the
//                            golden starter; user-editable thereafter.
//                            Wins over the baked copy when present.
//   /home/sprite/soul.md  — golden starter, replaced on golden bumps.
//
// Because there's exactly one canonical name ("default") on each side,
// there's no scan-and-collide step like the other registries; the
// generic Registry<T> would add traversal it doesn't need. We
// hand-roll the same user-wins fallback in 20 lines and expose the
// same `list()` / `get()` surface so call sites treat this like any
// other registry.

export interface Soul extends RegistryEntry {
  name: string
  body: string
  /** Absolute path the body was loaded from. */
  path: string
  source: 'user' | 'baked'
}

const userSoulPath = (): string => join(workspaceRoot(), 'soul.md')
const BAKED_SOUL_PATH = '/home/sprite/soul.md'
const CANONICAL_NAME = 'default'

async function readSoulFile(
  path: string,
  source: 'user' | 'baked',
): Promise<Soul | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const body = text.trim()
  if (body.length === 0) return null
  return { name: CANONICAL_NAME, body, path, source }
}

async function resolveSoul(): Promise<Soul | null> {
  return (
    (await readSoulFile(userSoulPath(), 'user')) ??
    (await readSoulFile(BAKED_SOUL_PATH, 'baked'))
  )
}

export const SoulRegistry = {
  async list(): Promise<Soul[]> {
    const s = await resolveSoul()
    return s ? [s] : []
  },
  async get(name: string): Promise<Soul | null> {
    if (name !== CANONICAL_NAME) return null
    return resolveSoul()
  },
}
