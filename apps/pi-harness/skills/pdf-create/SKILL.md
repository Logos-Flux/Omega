---
name: pdf-create
description: Generate a PDF file from your own written content. Activate when the user asks for "a PDF", "export this as PDF", "make a report I can download", or similar. Produces a downloadable file in the session uploads directory.
---

# PDF creation skill

Use this skill when the user wants a real PDF file they can save —
not just a written summary in the chat. The flow is: write markdown
to a file, run pandoc + weasyprint to produce a PDF in the same
directory, then tell the user the filename so they can download it.

## Protocol

1. **Compose the document** as markdown. Plan the structure first — title
   line (`# Title`), section headings (`##`), bullets, tables. Keep
   formatting modest; weasyprint handles standard markdown but exotic
   layouts can fail.

2. **Write the markdown to the workspace:**
   ```
   write_file(filename="<short-slug>.md", content="<full markdown>")
   ```
   Pick a short kebab-case slug — e.g. `meeting-notes-2026-04-30.md`,
   `q3-report.md`. The filename matters because the same slug is what
   the user sees in the download list.

3. **Render to PDF:**
   ```
   exec(command="pandoc",
        args=["<slug>.md", "-o", "<slug>.pdf",
              "--pdf-engine=weasyprint",
              "--metadata", "title:<short title>"])
   ```
   - `--pdf-engine=weasyprint` is required; the default LaTeX engine
     isn't installed in the sprite.
   - The `--metadata title:` is optional but suppresses pandoc's
     "Defaulting to '<filename>' as the title" warning.
   - Both files (`.md` source, `.pdf` output) end up in the user's
     uploads directory and become listable via `list_uploads`.

4. **Tell the user where to download.** One short line. The frontend
   renders chips for each upload; the user clicks the `.pdf` chip to
   download. Don't paste the whole document content again.

## Voice

After a successful render, one line. Examples:
- "Done — `q3-report.pdf` is ready below."
- "Generated `meeting-notes-2026-04-30.pdf`."

The frontend shows a download card under your reply automatically; do
NOT say things like "in your uploads" or "in your files panel" — the
user reads "your" as belonging to them and gets confused since they
didn't put it there. "Below" or "the download card" or just naming the
file is enough.

If pandoc returns non-zero or weasyprint warnings indicate something
visible (e.g. "no content"), surface that briefly: "PDF generated, but
weasyprint warned about X — open it to verify."

## What to skip

- Never paste the markdown source AND the PDF — pick one. If they
  asked for a PDF, deliver the PDF.
- Don't apologize about formatting limitations unprompted.
- Don't try to "preview" the PDF inline. The chat is text-only; the
  download chip is the deliverable.

## Limits

- 250 KB markdown source cap (write_file).
- 30s pandoc timeout.
- weasyprint emits CSS warnings (`Ignored 'overflow-x: auto'`, etc.) on
  pandoc's default template — these are harmless. Only flag exit-code
  failures.
- No images / SVGs in the PDF unless the user uploaded them and you
  reference them with a relative `![alt](filename)` markdown image.
