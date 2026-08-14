---
name: ocr
description: Extract text from an uploaded image (PNG, JPG, TIFF, etc.) or a scanned PDF using OCR. Activate when the user attaches an image and asks to read, transcribe, quote, or search the text in it — screenshots, photos of documents, receipts, whiteboards, scanned pages. Uses the system tesseract binary; pairs with pdftoppm to OCR scanned PDFs that pdf-extract cannot read.
---

# OCR (image → text) skill

The user's uploaded files are in their session uploads directory; they
appear in `<uploads>` in the system prompt. You don't read the image
bytes yourself — shell out to `tesseract` via the `exec` tool, which
prints the recognised text to stdout.

`cwd` is already the uploads directory, so refer to every file by
filename only (no path).

## Protocol — image files

1. **Confirm the upload exists.** If `<uploads>` lists no image
   (`.png`, `.jpg`/`.jpeg`, `.tif`/`.tiff`, `.bmp`, `.webp`), ask the
   user to attach one. Don't proceed.
2. **Run OCR:**
   ```
   exec(command="tesseract", args=["<filename>", "stdout", "-l", "eng"])
   ```
   - The literal word `stdout` as the output base sends text to stdout
     so it lands directly in the result — no temp file to read back.
   - `-l eng` is the default. If the user says the text is in another
     language, pass that tesseract language code instead (e.g.
     `-l fra`, `-l deu`, `-l spa`) — only if the language pack is
     installed; fall back to `eng` if a `-l` call errors.
   - For a single column of text the default works. If the result is
     garbled and the image is a sparse screenshot or a single line,
     retry with `--psm 6` (assume a uniform block) or `--psm 7`
     (single line) appended to args.
3. **Read the stdout from the result.** That's your source text.
4. **Answer the user's actual question** with it. If they asked to
   transcribe, return the cleaned text. If they asked a question about
   the image's text, quote the relevant line. If they asked to
   summarize, hand the OCR'd text to the `summarize` skill's protocol.

## Protocol — scanned PDFs

`pdf-extract` (pdftotext) returns near-empty on scanned PDFs because
they're images, not text. Bridge with OCR:

1. **Rasterise the PDF to PNGs** (300 DPI is a good OCR default):
   ```
   exec(command="pdftoppm", args=["-png", "-r", "300", "<filename>.pdf", "page"])
   ```
   This writes `page-1.png`, `page-2.png`, … into the uploads dir.
2. **OCR each page** with the tesseract step above, in order, and
   concatenate the results. For a one-page document do a single page.
   For many pages, OCR the first few and tell the user if you stopped
   early (each call has a 30s / 100 KB cap).

## Limits

- 100 KB stdout cap and 30s timeout per `exec` call (per `exec` rules).
  Large or many-page scans will truncate — say so in your reply.
- Accuracy depends on image quality. Low-resolution, skewed, or
  handwritten text comes back imperfect. Don't silently "correct"
  numbers, codes, or names into something plausible — if a character is
  ambiguous, flag it rather than guessing.
- `tesseract` must be installed in the sprite (`tesseract-ocr` apt
  package). If the call errors with "command not allowlisted" the
  harness is out of date; if it errors that the binary is missing, the
  golden hasn't shipped the package yet — tell the user OCR isn't
  available rather than fabricating text.

## Voice

Direct. Don't narrate the tool call ("I'll now run OCR…") — just do it
and answer. If anything went wrong (truncation, low-confidence output,
non-zero exit), say so in one sentence at the end of your reply.
