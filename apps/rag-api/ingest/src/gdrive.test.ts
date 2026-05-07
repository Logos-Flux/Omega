/**
 * Tests for the listing-side ingestability filter. The filter decides which
 * Drive files reach the per-file ingest loop; getting it wrong either misses
 * legitimate content (false negative) or routes uningestable native types to
 * downloadFile, which previously bombed the whole crawl (issue #4).
 *
 * Run with: bun test apps/rag-api/ingest/src/gdrive.test.ts
 */
import { describe, expect, it } from 'bun:test'
import { isIngestable } from './gdrive'

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
