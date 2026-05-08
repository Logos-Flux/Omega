import { useEffect, useState } from 'react'
import { BUNDLED_NAV_CONFIG, type NavConfig } from './nav-config'

function isValidNavConfig(value: unknown): value is NavConfig {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<NavConfig>
  return Array.isArray(candidate.links) && Array.isArray(candidate.menus)
}

/**
 * Resolves the top-bar nav config (links + mega-menus). Initial state
 * is the bundled fallback so the bar renders cleanly on first paint.
 *
 * If `seed` is provided (typically from `<AppShell links={…} menus={…}>`),
 * it overrides the bundled empty default — that's the static path most
 * deployments will use.
 *
 * If `configUrl` is also provided, the hook fetches that URL after
 * mount and replaces state with the response when valid. Lets ops
 * change nav without a redeploy. Network errors / 4xx-5xx / invalid
 * payloads fall back to whatever was already in state.
 */
export function useNavConfig(opts: {
  seed?: NavConfig
  configUrl?: string
}): NavConfig {
  const { seed, configUrl } = opts
  const [config, setConfig] = useState<NavConfig>(seed ?? BUNDLED_NAV_CONFIG)

  useEffect(() => {
    if (!configUrl) return
    const controller = new AbortController()

    fetch(configUrl, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return null
        return { data: (await res.json()) as unknown, fromOk: true }
      })
      .then((result) => {
        if (!result) return
        if (isValidNavConfig(result.data)) {
          setConfig(result.data)
        } else if (result.fromOk) {
          console.warn(
            '[app-shell] nav-config endpoint returned malformed payload, using bundled fallback',
            result.data,
          )
        }
      })
      .catch(() => {
        // Network error / aborted — bundled fallback is fine.
      })

    return () => controller.abort()
  }, [configUrl])

  return config
}
