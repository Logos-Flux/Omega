import { useEffect } from 'react'

/**
 * A theme is a flat map of CSS variable names → values. Variable
 * names are written WITHOUT the leading `--` for compactness in the
 * JSON; the hook adds it before applying. Values are applied as-is
 * (so any valid CSS color / length / etc. works).
 *
 * Example payload:
 *
 *   {
 *     "name": "Midnight",
 *     "tokens": {
 *       "color-t-deep":   "#0c0f1d",
 *       "color-t-bright": "#f4f5f8",
 *       "color-t-accent": "#9b8cff"
 *     }
 *   }
 */
export interface Theme {
  /** Display name. Currently unused by the hook itself; surfaced to UIs
   *  that build a theme picker. */
  name?: string
  tokens: Record<string, string>
}

const VAR_RX = /^[a-zA-Z][a-zA-Z0-9_-]*$/
const VALUE_MAX = 200

function isValidTheme(value: unknown): value is Theme {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Theme>
  if (typeof candidate.tokens !== 'object' || candidate.tokens === null) return false
  return true
}

function applyTokens(tokens: Record<string, string>): void {
  const root = document.documentElement
  for (const [rawKey, rawVal] of Object.entries(tokens)) {
    if (typeof rawVal !== 'string') continue
    if (rawVal.length > VALUE_MAX) continue
    // Strip an accidental leading `--` from the JSON so authors can
    // write tokens either way; reject anything that doesn't look like
    // a CSS custom property name.
    const key = rawKey.replace(/^-+/, '')
    if (!VAR_RX.test(key)) continue
    root.style.setProperty(`--${key}`, rawVal)
  }
}

/**
 * Fetch and apply a theme JSON at runtime.
 *
 * Lets a deployment swap the palette without rebuilding. The bundled
 * `:root` defaults from `styles.css` are still the first paint; the
 * fetched theme just calls `setProperty` on `document.documentElement`
 * after it lands, which CSS resolves at the same precedence as the
 * `:root` block.
 *
 * Called from `<AppShell themeUrl={…}>`. No-op when `themeUrl` is
 * undefined. Network errors / 4xx-5xx / malformed payloads fall back
 * to whatever was already applied.
 */
export function useTheme(themeUrl: string | undefined): void {
  useEffect(() => {
    if (!themeUrl) return
    const controller = new AbortController()

    fetch(themeUrl, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return null
        return { data: (await res.json()) as unknown, fromOk: true }
      })
      .then((result) => {
        if (!result) return
        if (isValidTheme(result.data)) {
          applyTokens(result.data.tokens)
        } else if (result.fromOk) {
          console.warn(
            '[app-shell] theme endpoint returned malformed payload; expected { tokens: Record<string,string> }',
            result.data,
          )
        }
      })
      .catch(() => {
        // Network error / aborted — bundled :root defaults are fine.
      })

    return () => controller.abort()
  }, [themeUrl])
}
