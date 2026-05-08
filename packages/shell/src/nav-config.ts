import type { NavLink, NavMenu } from './types'

/**
 * Shape of the runtime nav-config payload that `useNavConfig` fetches.
 * Operators host this at any URL of their choosing and pass that URL
 * via `<AppShell navConfigUrl="…">`. If no URL is set, the bundled
 * fallback below is used (which is itself empty by default — pass
 * `links` / `menus` props to populate without a network round trip).
 */
export interface NavConfig {
  /** Plain links rendered in the nav middle section */
  links: NavLink[]
  /** Mega-menus rendered alongside the plain links */
  menus: NavMenu[]
}

/**
 * Bundled fallback. OSS ships with an empty nav — the top bar just
 * shows the brand and the right-end slot until the operator populates
 * either via props or via the runtime `navConfigUrl` fetch.
 */
export const BUNDLED_NAV_CONFIG: NavConfig = {
  links: [],
  menus: [],
}
