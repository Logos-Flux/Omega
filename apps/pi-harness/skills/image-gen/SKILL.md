---
name: image-gen
description: Generate an image from a text description using Ideogram. ALWAYS load this and use the generate_image tool when the user asks to create, make, draw, design, render, or generate a picture, image, logo, illustration, poster, icon, banner, mockup, artwork, or photo — or attaches an image and asks for a variation. Ideogram renders legible text inside images, so it is especially good for logos, posters, signage, and anything with words.
---

# Image generation (Ideogram)

You make images by calling the **`generate_image` tool** — never by shelling
out, and never by trying to draw with text. The tool calls Ideogram 3.0
server-side, downloads the result, and saves each PNG into this session's
uploads. You get back **filenames, not pixels** — you cannot and must not try
to read the image bytes.

If `generate_image` is not in your tool list, image generation isn't enabled on
this sprite (no `IDEOGRAM_API_KEY`). Say so plainly instead of improvising.

## Protocol

1. **Write a strong prompt.** A good prompt names the *subject*, *style*,
   *composition*, *colors/lighting*, and *mood*. Turn a terse request into a
   vivid one — "a logo for a coffee shop" → "a minimalist logo for a coffee
   shop called 'Ember', a stylized flame inside a coffee bean, warm orange and
   deep brown, flat vector, clean negative space, white background".
   - **Text in the image:** quote the exact words in the prompt (e.g. `the
     words "GRAND OPENING" in bold serif`). Ideogram is good at this — lean on
     it for posters/logos/signage.
2. **Pick parameters** (all optional except `prompt`):
   - `aspect_ratio` — WxH form: `1x1` (default), `16x9` (wide), `9x16`
     (story/poster), `4x5`, `3x2`, etc. Note the **`x`, not a colon**.
   - `rendering_speed` — `FLASH` (fast draft) → `TURBO` → `DEFAULT` →
     `QUALITY` (polished final). Default `DEFAULT`. Use `QUALITY` when the user
     wants the finished piece; `FLASH`/`TURBO` for quick iterations.
   - `magic_prompt` — `AUTO`/`ON`/`OFF`. `ON` enriches a short prompt; set
     `OFF` when the user gave exact wording or precise text to render, so it
     isn't rewritten.
   - `style_type` — `REALISTIC` (photos), `DESIGN` (logos/graphics/typography),
     `FICTION` (illustration/concept art), `GENERAL`, or `AUTO`.
   - `negative_prompt` — what to exclude ("no text", "no people").
   - `num_images` — 1 (default) up to 8. Use 2–4 when the user wants options.
   - `seed` — reuse a prior seed to make a variation of an earlier image.
3. **Call the tool.** Don't narrate it ("I'll now generate…") — just call it.
4. **Report the result.** The tool returns the saved filename(s). Tell the user
   the image is ready, reference it by that exact filename, and note it's in
   their files / downloadable. If `num_images > 1`, list them. If a result came
   back with `is_image_safe: false`, mention it was flagged.

## When NOT to use this

- The user wants to *read* text out of an existing image → that's the `ocr`
  skill, not this.
- The user wants to edit/annotate a real document → Drive tools / pdf skills.

## Limits & failures

- The tool returns `{ error: … }` on an API failure (bad key, quota, a 422 on a
  rejected parameter). Surface the error briefly; don't pretend an image was
  made.
- Generation costs credits and takes a few seconds (longer at `QUALITY`).
  Don't fire off many calls speculatively — generate what was asked.

## Voice

Direct. One line of acknowledgement, the filename, done. Don't over-describe
the image you just made — the user can see it.
