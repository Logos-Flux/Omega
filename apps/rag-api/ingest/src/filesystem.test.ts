/**
 * Filesystem source tests. Walks isolated tmp directories so a buggy
 * implementation can't reach /etc or the dev's home dir; uses bun:test.
 *
 * Run with: bun test apps/rag-api/ingest/src/filesystem.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { _internal, filesystemSource } from './filesystem'
import type { SourceUser } from './source'

const FAKE_USER: SourceUser = {
  id: '00000000-0000-0000-0000-000000000001',
  tenant_id: '00000000-0000-0000-0000-00000000000a',
  chat_user_id: '00000000-0000-0000-0000-00000000000b',
  gdrive_my_ai_folder_id: null,
  gdrive_my_ai_status: 'unknown',
}

let scratch: string
const originalEnv = { ...process.env }

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'omega-fs-rag-'))
  process.env.RAG_FILES_DIR = scratch
  // Don't carry walk-depth overrides between tests.
  delete process.env.RAG_FILESYSTEM_MAX_DEPTH
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
  process.env = { ...originalEnv }
})

async function place(rel: string, body: string | Buffer = ''): Promise<void> {
  const abs = path.join(scratch, rel)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, body)
}

describe('filesystemSource.listForUser', () => {
  it('returns [] for an empty directory', async () => {
    const files = await filesystemSource.listForUser(FAKE_USER)
    expect(files).toEqual([])
  })

  it('throws when RAG_FILES_DIR is not set', async () => {
    delete process.env.RAG_FILES_DIR
    await expect(filesystemSource.listForUser(FAKE_USER)).rejects.toThrow(/RAG_FILES_DIR not set/)
  })

  it('lists ingestable files with relative POSIX ids', async () => {
    await place('handbook/chapter-1.md', '# Chapter 1\n')
    await place('policies.pdf', 'fake pdf bytes')
    const files = await filesystemSource.listForUser(FAKE_USER)
    const ids = files.map((f) => f.id).sort()
    expect(ids).toEqual(['handbook/chapter-1.md', 'policies.pdf'])
    const md = files.find((f) => f.id === 'handbook/chapter-1.md')!
    expect(md.mimeType).toBe('text/markdown')
    expect(md.name).toBe('chapter-1.md')
    expect(md.source).toBe('filesystem')
    // Sizes are stringified so the schema matches Drive's optional `size`.
    expect(md.size).toBe(String('# Chapter 1\n'.length))
    // ISO timestamp parses cleanly.
    expect(Number.isFinite(Date.parse(md.modifiedTime))).toBe(true)
  })

  it('skips dotfiles and dot-directories', async () => {
    await place('.git/config', '')
    await place('.DS_Store', '')
    await place('legit.md', '#')
    const files = await filesystemSource.listForUser(FAKE_USER)
    expect(files.map((f) => f.id)).toEqual(['legit.md'])
  })

  it('refuses to follow symlinks', async () => {
    // A symlink that points outside the root must NEVER yield a result.
    // We don't even let it surface as an entry — the source code drops
    // dirents whose `isSymbolicLink()` is true.
    await place('real.md', '#')
    await symlink('/etc/passwd', path.join(scratch, 'evil-link.md'))
    const files = await filesystemSource.listForUser(FAKE_USER)
    expect(files.map((f) => f.id)).toEqual(['real.md'])
  })

  it('skips files with unknown extensions', async () => {
    await place('thing.unknown', 'mystery bytes')
    await place('readme', 'no extension')
    await place('notes.md', '#')
    const files = await filesystemSource.listForUser(FAKE_USER)
    expect(files.map((f) => f.id)).toEqual(['notes.md'])
  })

  it('respects RAG_FILESYSTEM_MAX_DEPTH', async () => {
    process.env.RAG_FILESYSTEM_MAX_DEPTH = '2'
    await place('a/b/ok.md', '#')
    // depth 3 (a/b/c/) — descent should stop at depth=2 before reading c/
    await place('a/b/c/too-deep.md', '#')
    const files = await filesystemSource.listForUser(FAKE_USER)
    expect(files.map((f) => f.id)).toEqual(['a/b/ok.md'])
  })

  it('uses POSIX separators in ids regardless of host path.sep', async () => {
    await place(path.join('nested', 'deep', 'doc.md'), '#')
    const files = await filesystemSource.listForUser(FAKE_USER)
    expect(files[0]!.id).toBe('nested/deep/doc.md')
    expect(files[0]!.id).not.toContain('\\')
  })
})

describe('filesystemSource.download', () => {
  it('reads the file body for a listed entry', async () => {
    const body = 'hello, omega\n'
    await place('greeting.md', body)
    const [file] = await filesystemSource.listForUser(FAKE_USER)
    const dl = await filesystemSource.download(file!, FAKE_USER)
    expect(dl.body.toString('utf8')).toBe(body)
    expect(dl.filename).toBe('greeting.md')
    expect(dl.mimeType).toBe('text/markdown')
  })

  it('refuses absolute paths in source_id', async () => {
    await expect(
      filesystemSource.download(
        {
          id: '/etc/passwd',
          name: 'passwd',
          mimeType: 'text/plain',
          modifiedTime: new Date().toISOString(),
          source: 'filesystem',
        },
        FAKE_USER,
      ),
    ).rejects.toThrow(/looks absolute/)
  })

  it('refuses ".." escapes in source_id', async () => {
    await expect(
      filesystemSource.download(
        {
          id: '../../../etc/passwd',
          name: 'passwd',
          mimeType: 'text/plain',
          modifiedTime: new Date().toISOString(),
          source: 'filesystem',
        },
        FAKE_USER,
      ),
    ).rejects.toThrow(/escapes root/)
  })

  it('refuses to download a non-filesystem SourceFile', async () => {
    await expect(
      filesystemSource.download(
        {
          id: 'drive-id',
          name: 'x.pdf',
          mimeType: 'application/pdf',
          modifiedTime: new Date().toISOString(),
          source: 'drive',
        },
        FAKE_USER,
      ),
    ).rejects.toThrow(/non-filesystem/)
  })
})

describe('_internal helpers', () => {
  it('posixRelative normalises separators', () => {
    // path.sep on Linux is '/', so this is mostly a hint that callers
    // expect forward slashes — the explicit replace is what makes the
    // function safe on Windows hosts (which we don't currently target,
    // but the cost of the replace is zero).
    const rel = _internal.posixRelative('/root', '/root/a/b/c.md')
    expect(rel).toBe('a/b/c.md')
  })

  it('resolveSafe accepts in-tree ids', () => {
    const resolved = _internal.resolveSafe('/var/lib/omega/rag', 'docs/x.md')
    expect(resolved).toBe('/var/lib/omega/rag/docs/x.md')
  })

  it('resolveSafe rejects path-traversal escapes', () => {
    expect(() => _internal.resolveSafe('/var/lib/omega/rag', '../etc/passwd')).toThrow()
  })

  it('resolveSafe rejects scheme-prefixed ids', () => {
    expect(() => _internal.resolveSafe('/var/lib/omega/rag', 'file:///etc/passwd')).toThrow()
  })
})
