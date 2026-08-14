import { readFile } from 'node:fs/promises'
import { readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceRoot } from './memory'
import { Registry, type RegistryEntry } from './lib/registry'
import { parseFrontMatter } from './lib/frontmatter'

// Two skill sources, scanned in this order — first wins on name collision:
//   1. /workspace/skills/    — user-mutable. Survives golden updates.
//                              A user dropping their own skill here
//                              overrides any baked default of the same name.
//   2. /home/sprite/skills/  — golden-baked, read-only. Installed by
//                              apply-golden from goldens/<v>/skills/.
//                              Wiped + replaced on every golden bump.
//
// The dual-path scan + user-wins behaviour now lives in the generic
// `Registry<T>` (src/lib/registry.ts). This module just supplies the
// parse callback that turns a `<dir>/SKILL.md` into a SkillMeta and
// the public surface (listSkills/readSkill) that the assembler + WS
// handlers call.
export const userSkillsDir = (): string => join(workspaceRoot(), 'skills')
export const BAKED_SKILLS_DIR = '/home/sprite/skills'

export interface SkillMeta extends RegistryEntry {
  name: string
  description: string
  path: string
}

export interface SkillValidationIssue {
  path: string
  reason: string
}

// Parse callback for a single skill directory. Returns null when the
// skill is invalid (so the generic Registry skips it). The validation
// `issues` collected by `scanSkills` are produced separately — see
// below — because the generic Registry intentionally doesn't carry a
// diagnostic channel.
async function parseSkillDir(dir: string): Promise<SkillMeta | null> {
  const skillFile = join(dir, 'SKILL.md')
  let text: string
  try {
    text = await readFile(skillFile, 'utf8')
  } catch {
    return null
  }
  const { fm } = parseFrontMatter(text)
  const fallbackName = dir.split('/').filter(Boolean).pop() ?? ''
  const name = (fm.name ?? fallbackName).trim()
  const description = (fm.description ?? '').trim()
  if (!name) return null
  if (!description) return null
  return { name, description, path: dir }
}

const skillRegistry = new Registry<SkillMeta>({
  bakedDir: BAKED_SKILLS_DIR,
  userDir: userSkillsDir,
  parse: parseSkillDir,
})

// ---
// Diagnostics. The generic Registry returns valid entries only and has
// no view into "what was rejected and why" — that's by design (every
// registry has a different notion of validity). For the operator-
// facing `/skills?validate=1` endpoint we still want to report what
// got skipped, so we run a separate diagnostic scan that mirrors the
// generic's traversal but records reasons. The two scans produce the
// same valid set; only `issues` is unique to this path.
// ---
async function diagnoseDir(
  baseDir: string,
  source: 'user' | 'baked',
  seenNames: Set<string>,
  issues: SkillValidationIssue[],
): Promise<void> {
  if (!existsSync(baseDir)) return
  let entries: string[]
  try {
    entries = await readdir(baseDir)
  } catch {
    return
  }
  for (const entry of entries) {
    const dir = join(baseDir, entry)
    const skillFile = join(dir, 'SKILL.md')
    try {
      const s = await stat(dir)
      if (!s.isDirectory()) continue
    } catch {
      continue
    }
    let text: string
    try {
      text = await readFile(skillFile, 'utf8')
    } catch {
      issues.push({ path: dir, reason: 'missing SKILL.md' })
      continue
    }
    const { fm } = parseFrontMatter(text)
    const name = (fm.name ?? entry).trim()
    const description = (fm.description ?? '').trim()
    if (!name) {
      issues.push({ path: dir, reason: 'frontmatter `name` is empty' })
      continue
    }
    if (!description) {
      issues.push({
        path: dir,
        reason:
          'frontmatter `description` is empty — skill cannot be selected by the model',
      })
      continue
    }
    if (seenNames.has(name)) {
      issues.push({
        path: dir,
        reason: `duplicate skill name "${name}" — earlier source ${
          source === 'user' ? 'wins' : 'won'
        }`,
      })
      continue
    }
    seenNames.add(name)
  }
}

export async function scanSkills(): Promise<{
  skills: SkillMeta[]
  issues: SkillValidationIssue[]
}> {
  // Run both passes in parallel; they're read-only and independent.
  const issues: SkillValidationIssue[] = []
  const seenNames = new Set<string>()
  const [skills] = await Promise.all([
    listSkills(),
    (async () => {
      await diagnoseDir(userSkillsDir(), 'user', seenNames, issues)
      await diagnoseDir(BAKED_SKILLS_DIR, 'baked', seenNames, issues)
    })(),
  ])
  return { skills, issues }
}

export async function listSkills(): Promise<SkillMeta[]> {
  // The generic Registry caches across calls; reload here so callers
  // that drop a skill into /workspace/skills/ at runtime see it on the
  // next request without restarting the harness. (This matches the
  // pre-refactor behaviour, which always re-scanned.)
  skillRegistry.reload()
  return skillRegistry.list()
}

export async function readSkill(name: string): Promise<string | null> {
  const skills = await listSkills()
  const match = skills.find((s) => s.name === name)
  if (!match) return null
  try {
    return await readFile(join(match.path, 'SKILL.md'), 'utf8')
  } catch {
    return null
  }
}

export function buildSkillsSystemMessage(skills: SkillMeta[]): string | null {
  if (skills.length === 0) return null
  const lines = skills.map(
    (s) => `  <skill name="${s.name}">${s.description}</skill>`,
  )
  return [
    'You have access to the following skills. Each skill is a packaged set of',
    'instructions for handling a specific kind of task. The full body of each',
    'skill is hidden by default — call the `read_skill` tool with the skill',
    'name to load its instructions on demand, then follow them.',
    '',
    'LOADING RULE (mandatory): before you respond, check the user\'s message',
    'against every skill description below. If a skill\'s stated trigger phrase',
    'appears in the user\'s message verbatim, you MUST call `read_skill` for that',
    'skill and follow its instructions BEFORE answering — do not answer from',
    'general knowledge when a matching skill exists. A description that says',
    '"ALWAYS load before responding to X" is binding: treat X as a hard trigger.',
    'When in doubt between answering directly and loading a matching skill, load',
    'the skill.',
    '',
    '<available_skills>',
    ...lines,
    '</available_skills>',
  ].join('\n')
}
