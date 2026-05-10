/**
 * Tests for the listing-side ingestability filter. The filter decides which
 * Drive files reach the per-file ingest loop; getting it wrong either misses
 * legitimate content (false negative) or routes uningestable native types to
 * downloadFile, which previously bombed the whole crawl (issue #4).
 *
 * Run with: bun test apps/rag-api/ingest/src/gdrive.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { findFolderByName } from './gdrive'
import { isIngestable } from './mime'

// Mock googleapis at the module level so findFolderByName never hits a
// real Drive. The mock factory has to be installed before findFolderByName
// is first called in a test; bun:test's mock.module is hoisted enough for
// this to apply on the import that's already happened (we re-create the
// mock per-test via the closure below).
let nextListResponse: { files: Array<{ id?: string; name?: string; createdTime?: string }> } = {
  files: [],
}
let lastListArgs: Record<string, unknown> | null = null

mock.module('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
      },
    },
    drive: () => ({
      files: {
        list: async (args: Record<string, unknown>) => {
          lastListArgs = args
          return { data: nextListResponse }
        },
      },
    }),
  },
}))

describe('isIngestable', () => {
  const cases: Array<{ mime: string; expected: boolean; why: string }> = [
    // Folders — recursed into by walkFolder, never ingested directly.
    { mime: 'application/vnd.google-apps.folder', expected: false, why: 'folder' },

    // Google-native types we have an exporter for: Docs, Sheets, Slides.
    { mime: 'application/vnd.google-apps.document', expected: true, why: 'Google Doc → docx export' },
    { mime: 'application/vnd.google-apps.spreadsheet', expected: true, why: 'Google Sheet → xlsx export' },
    { mime: 'application/vnd.google-apps.presentation', expected: true, why: 'Google Slides → pptx export' },

    // Google-native types we deliberately skip — exporting these would either
    // fail outright (Forms, Sites, Scripts, Shortcuts) or produce content
    // that the RAG pipeline can't usefully ingest (Drawings).
    { mime: 'application/vnd.google-apps.drawing', expected: false, why: 'drawing — image-only, skip' },
    { mime: 'application/vnd.google-apps.form', expected: false, why: 'form — no useful export' },
    { mime: 'application/vnd.google-apps.script', expected: false, why: 'apps script — code, not content' },
    { mime: 'application/vnd.google-apps.shortcut', expected: false, why: 'shortcut — pointer, not file' },
    { mime: 'application/vnd.google-apps.site', expected: false, why: 'sites — html, no clean export' },
    { mime: 'application/vnd.google-apps.map', expected: false, why: 'my-maps — kml, skip' },

    // Ordinary binary mimetypes — pass through to files.get(alt:'media').
    { mime: 'application/pdf', expected: true, why: 'PDF — direct download' },
    { mime: 'text/csv', expected: true, why: 'CSV — direct download' },
    { mime: 'text/plain', expected: true, why: 'plain text' },
    { mime: 'text/markdown', expected: true, why: 'markdown' },
    { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', expected: true, why: 'native .docx upload' },
    { mime: 'image/png', expected: true, why: 'image — RAGFlow ignores or OCRs' },
    { mime: 'application/zip', expected: true, why: 'unknown binary — let the pipeline decide' },
  ]

  it.each(cases)('$mime → $expected ($why)', ({ mime, expected }) => {
    expect(isIngestable(mime)).toBe(expected)
  })
})

describe('findFolderByName', () => {
  beforeEach(() => {
    nextListResponse = { files: [] }
    lastListArgs = null
  })
  afterEach(() => {
    lastListArgs = null
  })

  it('returns null when no folder of that name exists', async () => {
    nextListResponse = { files: [] }
    const result = await findFolderByName('access-token', 'my-ai')
    expect(result).toBeNull()
  })

  it('returns the id when exactly one folder matches', async () => {
    nextListResponse = { files: [{ id: 'folder-abc', name: 'my-ai', createdTime: '2026-01-01T00:00:00Z' }] }
    const result = await findFolderByName('access-token', 'my-ai')
    expect(result).toEqual({ id: 'folder-abc', ambiguous: false })
  })

  it('returns the oldest match with ambiguous=true when multiple folders exist', async () => {
    // The route asks for orderBy: 'createdTime' (ascending) so the first
    // entry IS the oldest — we don't sort client-side.
    nextListResponse = {
      files: [
        { id: 'folder-old', name: 'my-ai', createdTime: '2025-06-01T00:00:00Z' },
        { id: 'folder-new', name: 'my-ai', createdTime: '2026-04-01T00:00:00Z' },
      ],
    }
    const result = await findFolderByName('access-token', 'my-ai')
    expect(result).toEqual({ id: 'folder-old', ambiguous: true })
  })

  it('escapes single quotes in the folder name', async () => {
    nextListResponse = { files: [{ id: 'folder-x', name: "bob's docs", createdTime: '2026-01-01T00:00:00Z' }] }
    const result = await findFolderByName('access-token', "bob's docs")
    expect(result).toEqual({ id: 'folder-x', ambiguous: false })
    // The query string passed to Drive must escape the inner quote so
    // the q parser doesn't terminate the literal early.
    expect(lastListArgs?.q).toContain("name = 'bob\\'s docs'")
  })

  it("scopes to folders the user owns ('me' in owners)", async () => {
    nextListResponse = { files: [{ id: 'folder-x', name: 'my-ai', createdTime: '2026-01-01T00:00:00Z' }] }
    await findFolderByName('access-token', 'my-ai')
    expect(lastListArgs?.q).toContain("'me' in owners")
    expect(lastListArgs?.q).toContain("trashed = false")
    expect(lastListArgs?.orderBy).toBe('createdTime')
  })
})
