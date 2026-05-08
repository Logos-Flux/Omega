// Tests for the uploads helper — particularly deleteUpload, the
// route enabling the user-facing "remove from uploads" affordance.
// WORKSPACE_ROOT is captured at first load of ./src/memory.ts, so we
// set it BEFORE importing anything that transitively pulls it.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK_ROOT = mkdtempSync(join(tmpdir(), 'pi-harness-uploads-'))
process.env.WORKSPACE_ROOT = WORK_ROOT

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'

const { deleteUpload, listUploads, saveUpload, uploadPath } = await import('../src/uploads')

const SID = 'sess-uploads-test'

beforeEach(async () => {
  await rm(join(WORK_ROOT, 'uploads'), { recursive: true, force: true })
})

afterAll(async () => {
  await rm(WORK_ROOT, { recursive: true, force: true })
})

function fakeFile(name: string, contents: string): File {
  return new File([contents], name, { type: 'text/plain' })
}

describe('deleteUpload', () => {
  test('returns false when the file does not exist (no-op, no throw)', async () => {
    const result = await deleteUpload(SID, 'never-was.txt')
    expect(result).toBe(false)
  })

  test('returns true and removes the file when it exists', async () => {
    await saveUpload(SID, fakeFile('hello.txt', 'world'))
    expect(existsSync(uploadPath(SID, 'hello.txt'))).toBe(true)

    const result = await deleteUpload(SID, 'hello.txt')
    expect(result).toBe(true)
    expect(existsSync(uploadPath(SID, 'hello.txt'))).toBe(false)

    const remaining = await listUploads(SID)
    expect(remaining).toEqual([])
  })

  test('only removes the targeted file — siblings survive', async () => {
    await saveUpload(SID, fakeFile('keep.txt', 'a'))
    await saveUpload(SID, fakeFile('drop.txt', 'b'))

    await deleteUpload(SID, 'drop.txt')

    const remaining = await listUploads(SID)
    expect(remaining.map((u) => u.filename)).toEqual(['keep.txt'])
  })

  test('rejects invalid session ids (path-traversal defense)', async () => {
    await expect(deleteUpload('../etc', 'passwd')).rejects.toThrow(/invalid sessionId/)
  })

  test('cannot reach files in another session (path-traversal defense)', async () => {
    // Set up a victim session with a file we want to protect.
    const VICTIM_SID = 'sess-victim'
    await saveUpload(VICTIM_SID, fakeFile('secret.txt', 'do not delete'))
    await saveUpload(SID, fakeFile('attacker.txt', 'a'))

    // Attempt to escape SID by passing a filename that traverses up.
    // safeFilename runs basename() + char-strip, collapsing the result
    // to 'secret.txt' — which is then resolved INSIDE SID's dir, not
    // VICTIM_SID's. So nothing should happen to the victim.
    await deleteUpload(SID, '../sess-victim/secret.txt')

    const victimFiles = await listUploads(VICTIM_SID)
    expect(victimFiles.map((u) => u.filename)).toEqual(['secret.txt'])
  })
})
