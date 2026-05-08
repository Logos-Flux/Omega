// Brand identity surfaced in the UI. Two tokens are env-overridable
// at build time so a deployment can rename without forking:
//
//   VITE_BRAND_NAME   — the wordmark (default: "Omega")
//   VITE_BRAND_GLYPH  — the single-character mark used as an avatar /
//                       inline accent (default: "Ω")
//
// Read once at module load — Vite inlines `import.meta.env.VITE_*` at
// build time, so changing the env requires a frontend rebuild (the
// CDN-style cached bundle is what carries the old value).

const NAME = (import.meta.env.VITE_BRAND_NAME as string | undefined)?.trim()
const GLYPH = (import.meta.env.VITE_BRAND_GLYPH as string | undefined)?.trim()

export const brand = {
  name: NAME && NAME.length > 0 ? NAME : 'Omega',
  glyph: GLYPH && GLYPH.length > 0 ? GLYPH : 'Ω',
}
