// Snapshot harness for the PromptAssembler.
//
// Phase I.A of the pi-harness ROADMAP extracts the system-message
// assembly out of the legacy `chat.ts::buildModelMessages` into
// `src/assembler.ts::PromptAssembler.build`. The snapshots in
// `test/fixtures/<name>.snapshot.json` lock down its output byte-for-
// byte across the refactor. The current snapshots were regenerated
// when slot ordering split the old single concatenated system message
// into one ModelMessage per active slot — see commit body for the
// rationale. Slots 1–7 carry an Anthropic `cacheControl: ephemeral`
// providerOptions marker (I.A.4); Gemini and Perplexity get no
// per-message cache hint today.
//
// On first run (or when env `UPDATE_SNAPSHOTS=1` is set) the snapshot is
// written; otherwise it is asserted to be byte-identical.

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `WORKSPACE_ROOT` is captured once at module-load time inside
// `src/memory.ts`. It must be set BEFORE any `import` that transitively
// pulls in `src/memory.ts` — including the assembler import below —
// so we set it synchronously at the top of the file, before the imports.
const WORK_ROOT = mkdtempSync(join(tmpdir(), 'pi-harness-snap-'))
process.env.WORKSPACE_ROOT = WORK_ROOT
mkdirSync(join(WORK_ROOT, 'conversations'), { recursive: true })

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Invocation } from '../src/types'

// Dynamic import: ES module `import` declarations are hoisted, which
// would evaluate `src/memory.ts` before the env-var assignment above
// could take effect. Awaiting the import here keeps the ordering
// honest — `WORKSPACE_ROOT` is already set when the assembler (and
// transitively `memory.ts`) first loads.
const { PromptAssembler } = await import('../src/assembler')

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(HERE, 'fixtures')
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1'

interface Upload {
  filename: string
  size: number
}

interface SkillSpec {
  name: string
  description: string
}

interface ConversationLine {
  ts: string
  role: 'user' | 'assistant'
  text: string
  provider?: string
  model?: string
}

interface Fixture {
  description: string
  sessionId: string
  latestUserText: string
  provider: 'anthropic' | 'google' | 'perplexity'
  now: string
  workspace: {
    memory: string | null
    conversation: ConversationLine[]
    uploads: Upload[]
    skills: SkillSpec[]
    // Optional. When present, written verbatim to /workspace/profile.json
    // so the assembler's slot 3 reader exercises a populated profile.
    // Absent (or null) keeps the slot inert via the missing-file path.
    profile?: unknown
  }
}

afterAll(async () => {
  if (existsSync(WORK_ROOT)) {
    await rm(WORK_ROOT, { recursive: true, force: true })
  }
})

async function listFixtures(): Promise<string[]> {
  const entries = await readdir(FIXTURES_DIR)
  return entries.filter((f) => f.endsWith('.json') && !f.endsWith('.snapshot.json')).sort()
}

async function materialiseWorkspace(fix: Fixture): Promise<void> {
  // Wipe anything left over from a prior fixture in this run. Each
  // fixture must see only its own state.
  for (const entry of await readdir(WORK_ROOT)) {
    await rm(join(WORK_ROOT, entry), { recursive: true, force: true })
  }
  await mkdir(join(WORK_ROOT, 'conversations'), { recursive: true })

  if (fix.workspace.memory !== null) {
    // Canonical path post I.C — assembler slot 4 only reads from here.
    // The legacy /workspace/memory.md is migrated by ensureWorkspace,
    // not by the assembler, so the snapshot harness writes directly to
    // the post-migration location.
    await mkdir(join(WORK_ROOT, 'memory'), { recursive: true })
    await writeFile(
      join(WORK_ROOT, 'memory', '_global.md'),
      fix.workspace.memory,
      'utf8',
    )
  }

  if (fix.workspace.conversation.length > 0) {
    const path = join(WORK_ROOT, 'conversations', `${fix.sessionId}.jsonl`)
    const body = fix.workspace.conversation.map((l) => JSON.stringify(l)).join('\n') + '\n'
    await writeFile(path, body, 'utf8')
  }

  if (fix.workspace.uploads.length > 0) {
    const dir = join(WORK_ROOT, 'uploads', fix.sessionId)
    await mkdir(dir, { recursive: true })
    for (const u of fix.workspace.uploads) {
      // listUploads only reads filename + on-disk size, so any payload
      // of the right length is fine. Snapshot byte-identity comes from
      // the size matching the fixture.
      await writeFile(join(dir, u.filename), Buffer.alloc(u.size))
    }
  }

  if (fix.workspace.profile !== undefined && fix.workspace.profile !== null) {
    await writeFile(
      join(WORK_ROOT, 'profile.json'),
      JSON.stringify(fix.workspace.profile, null, 2),
      'utf8',
    )
  }

  if (fix.workspace.skills.length > 0) {
    const skillsRoot = join(WORK_ROOT, 'skills')
    await mkdir(skillsRoot, { recursive: true })
    for (const s of fix.workspace.skills) {
      const dir = join(skillsRoot, s.name)
      await mkdir(dir, { recursive: true })
      const md = `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n# ${s.name}\n\nFixture skill body.\n`
      await writeFile(join(dir, 'SKILL.md'), md, 'utf8')
    }
  }
}

describe('PromptAssembler snapshot', async () => {
  const fixtureFiles = await listFixtures()
  expect(fixtureFiles.length).toBeGreaterThan(0)

  for (const file of fixtureFiles) {
    const name = file.replace(/\.json$/, '')

    test(name, async () => {
      const raw = await readFile(join(FIXTURES_DIR, file), 'utf8')
      const fix = JSON.parse(raw) as Fixture
      await materialiseWorkspace(fix)

      // Hand-build an Invocation to bypass the dispatcher (which has
      // its own provider/model validation, irrelevant here). Snapshot
      // covers the assembled `systemMessages` + `modelMessages`
      // concatenated — the same shape the engine hands to streamText.
      const invocation: Invocation = {
        trigger: 'user',
        inputType: 'prompt',
        sessionId: fix.sessionId,
        userId: 'snapshot-user',
        personaName: 'default',
        soulName: 'default',
        prompt: fix.latestUserText,
        provider: fix.provider,
        model: 'snapshot-model',
        budget: {},
        policy: {},
        delivery: 'ws',
      }

      const payload = await PromptAssembler.build(invocation, {
        now: new Date(fix.now),
      })
      const messages = [...payload.systemMessages, ...payload.modelMessages]

      const serialised = JSON.stringify(messages, null, 2) + '\n'
      const snapshotPath = join(FIXTURES_DIR, `${name}.snapshot.json`)

      if (UPDATE || !existsSync(snapshotPath)) {
        await writeFile(snapshotPath, serialised, 'utf8')
      }

      const expected = await readFile(snapshotPath, 'utf8')
      expect(serialised).toBe(expected)
    })
  }
})
