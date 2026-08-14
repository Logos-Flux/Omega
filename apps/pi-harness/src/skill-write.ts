// #4 — auto skill generator. The agent (driven by the skill-creator skill)
// synthesises a new SKILL.md and persists it here, into the user-mutable
// /workspace/skills/<name>/ tree. That tree survives golden updates and is
// scanned by the same Registry as the baked skills (skills.ts), so a
// freshly-written skill shows up in the catalog (and the Settings toggle
// list) on the next scan — no restart.
//
// write_file (uploads.ts) deliberately can't reach outside the session
// uploads dir, so skill creation goes through this dedicated, validated
// path instead. Validation mirrors skills.ts::parseSkillDir's contract
// (non-empty name + description) plus the frontmatter parser's line-based
// scalars-only limitation (no newlines in name/description).

import { mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BAKED_SKILLS_DIR, userSkillsDir } from './skills'

export class SkillWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillWriteError'
  }
}

// Lowercase kebab — keeps the name safe as a directory component and as a
// frontmatter scalar, and matches the convention of the baked skills
// (pdf-extract, skill-creator, …).
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export interface WriteSkillInput {
  name: string
  description: string
  body: string
}

export interface WriteSkillResult {
  name: string
  path: string
  /** True when an existing user skill of the same name was overwritten. */
  overwritten: boolean
}

/** Collapse any whitespace run (incl. newlines) to a single space + trim.
 *  The frontmatter parser is line-based, so the description MUST be a
 *  single line; this makes a multi-line description safe rather than
 *  silently truncating it at the first newline. */
function singleLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export async function writeSkill(input: WriteSkillInput): Promise<WriteSkillResult> {
  const name = (input.name ?? '').trim()
  if (!NAME_RE.test(name)) {
    throw new SkillWriteError(
      'invalid skill name: use lowercase letters, digits and dashes (e.g. "weekly-report"), 1–64 chars',
    )
  }
  const description = singleLine(input.description ?? '')
  if (!description) {
    throw new SkillWriteError('description is required (one line; it is how the model decides to use the skill)')
  }
  const body = (input.body ?? '').trim()
  if (!body) {
    throw new SkillWriteError('body is required (the SKILL.md instructions)')
  }

  // Never let a user skill silently shadow a built-in (baked) one — the
  // Registry would prefer the user copy and the operator would have no
  // idea their golden skill stopped applying. Surface it instead.
  if (existsSync(join(BAKED_SKILLS_DIR, name, 'SKILL.md'))) {
    throw new SkillWriteError(
      `a built-in skill named "${name}" already exists — choose a different name`,
    )
  }

  const dir = join(userSkillsDir(), name)
  const file = join(dir, 'SKILL.md')
  const overwritten = existsSync(file)

  const md = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
  await mkdir(dir, { recursive: true })
  await writeFile(file, md, 'utf8')

  return { name, path: file, overwritten }
}

/**
 * Delete a USER skill (under /workspace/skills/<name>/). Baked skills are
 * never touched — a name that only exists as a baked skill returns false
 * (the caller surfaces a 404/409). Returns true when a user skill dir was
 * removed.
 */
export async function deleteUserSkill(rawName: string): Promise<boolean> {
  const name = (rawName ?? '').trim()
  if (!NAME_RE.test(name)) return false
  const dir = join(userSkillsDir(), name)
  if (!existsSync(join(dir, 'SKILL.md'))) return false
  await rm(dir, { recursive: true, force: true })
  return true
}
