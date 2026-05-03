import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { workspaceRoot } from './memory'
import { Registry, type RegistryEntry } from './lib/registry'
import { parseFrontMatter } from './lib/frontmatter'

// PersonaRegistry — the *what* of the agent: capability scope, role,
// available skills/tools/KB corpora, denials. Replaceable per task.
//
// Layout (per AGENT_ARCHITECTURE.md L312-313 / L341-345):
//   /workspace/personas/<name>/persona.md   — user, persists across goldens
//   /home/sprite/personas/<name>/persona.md — golden-baked, read-only
//
// Phase I serves a single "default" persona baked at
// /home/sprite/personas/default/persona.md so the assembler's slot 5
// has a registry to consult. Slot 5 still emits no body in Phase I —
// the default persona ships an empty body — but the read happens
// through the registry so adding alternates in later phases is a
// matter of dropping more directories rather than touching code.

const userPersonasDir = (): string => join(workspaceRoot(), 'personas')
const BAKED_PERSONAS_DIR = '/home/sprite/personas'

/**
 * Parsed persona. Frontmatter fields follow AGENT_ARCHITECTURE.md
 * L91-93 + the persona example: `name` is required; everything else
 * is optional and drives later-phase behaviour (skill filtering in
 * VI, tool gating in IX, KB scoping in IV, memory routing in VI).
 *
 * The fields live on the Persona type from Phase I onward so that
 * later phases just *consume* them — they don't have to touch the
 * persona registry shape.
 */
export interface Persona extends RegistryEntry {
  name: string
  /** Skills this persona is allowed to load. `null` = unfiltered. */
  skills: string[] | null
  /** Tools the persona is denied. Activated in Phase IX. */
  toolsDenied: string[]
  /** KB corpora in scope. Activated in Phase IV. */
  knowledgeCorpora: string[]
  /** Memory partitions the persona may read/write. Activated in Phase VI. */
  memoryScope: string | null
  /** Optional lifecycle hooks. Activated in Phase VII. */
  hooks: string[] | null
  /** Persona body (markdown). Goes into assembler slot 5. */
  body: string
  /** Absolute path to the directory holding persona.md. */
  path: string
}

function splitList(raw: string | undefined): string[] | null {
  if (raw === undefined || raw === '') return null
  // Accept either a JSON-ish array (`["a","b"]`) or a comma-separated
  // string. The frontmatter parser is scalars-only, so even an array
  // literal arrives here as a string — we just split it.
  const trimmed = raw.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1)
    return inner
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
  }
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function parsePersonaDir(dir: string): Promise<Persona | null> {
  const file = join(dir, 'persona.md')
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return null
  }
  const { fm, body } = parseFrontMatter(text)
  const fallbackName = dir.split('/').filter(Boolean).pop() ?? ''
  const name = (fm.name ?? fallbackName).trim()
  if (!name) return null
  return {
    name,
    skills: splitList(fm.skills),
    toolsDenied: splitList(fm.tools_denied) ?? [],
    knowledgeCorpora:
      splitList(fm.knowledge) ?? splitList(fm.knowledge_corpora) ?? [],
    memoryScope: fm.memory_scope?.trim() || null,
    hooks: splitList(fm.hooks),
    body: body.trim(),
    path: dir,
  }
}

const personaRegistry = new Registry<Persona>({
  bakedDir: BAKED_PERSONAS_DIR,
  userDir: userPersonasDir,
  parse: parsePersonaDir,
})

export const PersonaRegistry = {
  async list(): Promise<Persona[]> {
    personaRegistry.reload()
    return personaRegistry.list()
  },
  async get(name: string): Promise<Persona | null> {
    personaRegistry.reload()
    return personaRegistry.get(name)
  },
}
