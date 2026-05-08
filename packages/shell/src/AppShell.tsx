import { useEffect, useState, type ReactNode } from 'react'
import { TopNav } from './TopNav'
import { useNavConfig } from './use-nav-config'
import type { AppId, NavLink, NavMenu } from './types'

export interface AppShellProps {
  /**
   * Identifier for the app currently rendering. Drives top-bar active
   * highlighting against `link.appId` / `menu.containedAppIds`.
   */
  appId?: AppId
  /**
   * Per-app tools panel rendered to the left of `children`. Width is
   * fixed at 240px. Always reachable via the panel-toggle button in
   * the top bar:
   * - On `md+`, the drawer is part of the layout flow and toggles in/out.
   * - Below `md`, the drawer becomes a fixed overlay with a backdrop.
   * Default state: open on `md+`, closed below `md`.
   */
  drawer?: ReactNode
  /** Right-end slot of the top bar — typically `<UserMenu />`. */
  topNavEndSlot?: ReactNode
  /** Brand wordmark text. Default: "Omega". */
  brandText?: string
  /** Brand wordmark link target. Default: `/`. */
  brandHref?: string
  /**
   * Static nav links for the top bar. When a `navConfigUrl` is set,
   * a successful runtime fetch overrides these. Otherwise these
   * + `menus` are what the top bar renders.
   */
  links?: NavLink[]
  /** Static mega-menus alongside `links`. Same override rules. */
  menus?: NavMenu[]
  /**
   * If set, fetch `{ links, menus }` from this URL after mount and
   * use it for the top bar. Lets ops change nav without a redeploy.
   * Falls back to the static `links` / `menus` (or empty defaults)
   * on any fetch / parse failure.
   */
  navConfigUrl?: string
  /**
   * When true, the TopNav floats above the content and is hidden by
   * default, sliding into view when the cursor approaches the top
   * edge of the viewport. Useful for pages that mock up their own
   * nav (e.g., a showcase) and shouldn't have the real bar competing
   * visually with the demo. The page content fills the full viewport
   * — there is no spacer for the hidden bar.
   */
  floatingTopNav?: boolean
  children: ReactNode
}

const MOBILE_QUERY = '(max-width: 767px)'

export function AppShell({
  appId,
  drawer,
  topNavEndSlot,
  brandText,
  brandHref,
  links: staticLinks,
  menus: staticMenus,
  navConfigUrl,
  floatingTopNav,
  children,
}: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(true)
  useEffect(() => {
    if (typeof window === 'undefined' || !drawer) return
    const mql = window.matchMedia(MOBILE_QUERY)
    setDrawerOpen(!mql.matches)
  }, [drawer])

  const navConfig = useNavConfig({
    seed: { links: staticLinks ?? [], menus: staticMenus ?? [] },
    configUrl: navConfigUrl,
  })

  const topNav = (
    <TopNav
      appId={appId}
      brandText={brandText}
      brandHref={brandHref}
      links={navConfig.links}
      menus={navConfig.menus}
      endSlot={topNavEndSlot}
      onToggleDrawer={drawer ? () => setDrawerOpen((v) => !v) : undefined}
      drawerOpen={drawerOpen}
    />
  )

  return (
    <div className="flex h-screen flex-col bg-t-deep text-t-bright">
      {floatingTopNav ? (
        // Fixed 8px hover trigger at the top edge of the viewport. The
        // nav is an absolute child translated -100% (offscreen). On
        // group-hover it slides into view; mouse-leave slides it out.
        // CSS-only — no JS, no scroll listeners.
        <div className="group fixed inset-x-0 top-0 z-50 h-2">
          <div className="absolute inset-x-0 top-0 -translate-y-full transition-transform duration-200 ease-out group-hover:translate-y-0">
            {topNav}
          </div>
        </div>
      ) : (
        topNav
      )}
      <div className="relative flex min-h-0 flex-1">
        {drawer && drawerOpen && (
          <>
            {/* Mobile backdrop: tap to close */}
            <button
              type="button"
              aria-label="Close sidebar"
              onClick={() => setDrawerOpen(false)}
              className="fixed inset-0 top-12 z-10 bg-black/30 md:hidden"
            />
            <aside className="fixed bottom-0 left-0 top-12 z-20 flex w-60 shrink-0 flex-col border-r border-t-border bg-t-surface md:static md:top-0">
              {drawer}
            </aside>
          </>
        )}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
      </div>
    </div>
  )
}
