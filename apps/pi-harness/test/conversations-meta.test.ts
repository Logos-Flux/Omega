// listConversationsWithMeta — the data behind the agent-mode thread switcher.
//
// Behaviours under test:
//   1. Every non-empty session is returned with a title (first user message,
//      one line, ≤80 chars), a messageCount, and an updatedAt.
//   2. Empty / contentless sessions (just-minted shells) are dropped.
//   3. Results are sorted newest-first by updatedAt.

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK_ROOT = mkdtempSync(join(tmpdir(), 'pi-harness-convmeta-'))
process.env.WORKSPACE_ROOT = WORK_ROOT
const CONV_DIR = join(WORK_ROOT, 'conversations')
mkdirSync(CONV_DIR, { recursive: true })

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { rm, writeFile, utimes } from 'node:fs/promises'

const { listConversationsWithMeta } = await import('../src/memory')

function line(role: 'user' | 'assistant', text: string): string {
  return JSON.stringify({ ts: new Date().toISOString(), role, text }) + '\n'
}

async function seed(id: string, body: string, mtime?: Date): Promise<void> {
  const path = join(CONV_DIR, `${id}.jsonl`)
  await writeFile(path, body, 'utf8')
  if (mtime) await utimes(path, mtime, mtime)
}

describe('listConversationsWithMeta', () => {
  beforeEach(async () => {
    await rm(CONV_DIR, { recursive: true, force: true })
    mkdirSync(CONV_DIR, { recursive: true })
  })

  afterAll(async () => {
    await rm(WORK_ROOT, { recursive: true, force: true })
  })

  test('returns title from the first user message + a message count', async () => {
    await seed('aaa', line('user', 'How do I export the report?') + line('assistant', 'You can…'))
    const metas = await listConversationsWithMeta()
    expect(metas).toHaveLength(1)
    expect(metas[0]!.id).toBe('aaa')
    expect(metas[0]!.title).toBe('How do I export the report?')
    expect(metas[0]!.messageCount).toBe(2)
  })

  test('drops empty / contentless sessions (just-minted shells)', async () => {
    await seed('used', line('user', 'hi'))
    await seed('empty', '')
    const metas = await listConversationsWithMeta()
    expect(metas.map((m) => m.id)).toEqual(['used'])
  })

  test('collapses whitespace and caps the title at 80 chars', async () => {
    const long = 'word '.repeat(40) // 200 chars with spaces
    await seed('long', line('user', `multi\n   line   ${long}`))
    const [meta] = await listConversationsWithMeta()
    expect(meta!.title!.length).toBeLessThanOrEqual(80)
    expect(meta!.title).not.toContain('\n')
    expect(meta!.title!.startsWith('multi line word')).toBe(true)
  })

  test('sorts newest-first by updatedAt', async () => {
    await seed('older', line('user', 'first'), new Date('2026-01-01T00:00:00Z'))
    await seed('newer', line('user', 'second'), new Date('2026-06-01T00:00:00Z'))
    const metas = await listConversationsWithMeta()
    expect(metas.map((m) => m.id)).toEqual(['newer', 'older'])
  })
})
