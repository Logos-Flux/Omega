---
name: pdf-extract
description: Extract plain text from a PDF file the user has uploaded. Activate when the user attaches a .pdf and asks to read, summarize, search, or quote from it. Uses the system pdftotext binary (poppler-utils) — does not handle scanned PDFs (no OCR).
---

# PDF text extraction skill

The user's PDF is in their session uploads directory; it appears in
`<uploads>` in the system prompt. You don't need to read the binary
contents — instead, shell out to `pdftotext` via the `exec` tool to get
clean plain text, then work with that.

## Protocol

1. **Confirm the upload exists.** If `<uploads>` lists no `.pdf`, ask
   the user to attach one. Don't proceed.
2. **Extract text:**
   ```
   exec(command="pdftotext", args=["-layout", "<filename>.pdf", "-"])
   ```
   - `-layout` preserves visual reading order (better for tables).
   - The trailing `-` writes to stdout instead of a file, so you get the
     text directly in the result.
   - `cwd` is already set to the uploads directory, so refer to the
     file by filename only (no path).
3. **Read the stdout from the result.** That's your source text.
4. **Answer the user's actual question** using that text. If they asked
   to summarize, use the `summarize` skill's protocol on the extracted
   text. If they asked a specific question, quote the relevant sentence.

## Limits

- 100 KB stdout cap (per `exec` rules). For longer PDFs, the text will
  be truncated; mention this in your reply.
- 30s timeout. Most PDFs return in under a second.
- If `pdftotext` returns mostly empty (a few page-feeds and little
  text), the PDF is probably scanned (images, not text). Switch to the
  `ocr` skill — its "scanned PDFs" protocol rasterises the pages with
  pdftoppm and runs tesseract over them. Don't fabricate content.

## Voice

Direct. Don't narrate the tool call ("I'll now extract the PDF…") —
just do it and answer. If anything went wrong (truncation, empty
extraction, non-zero exit), say so in one sentence at the end of your
reply.
