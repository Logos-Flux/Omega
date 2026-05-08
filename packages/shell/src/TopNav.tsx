import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, PanelLeftOpen, PanelLeftClose } from 'lucide-react'
import { cn } from './lib/cn'
import type { AppId, NavLink, NavMenu } from './types'

export interface TopNavProps {
  /**
   * The app currently rendering. Used to highlight the matching nav item.
   * Mega-menu children whose `appId` matches keep the menu's button
   * highlighted while also marking themselves active inside the dropdown.
   */
  appId?: AppId
  /** Brand wordmark text (left of the nav). Default: "Omega". */
  brandText?: string
  /** Brand wordmark link target. Default: `/`. */
  brandHref?: string
  /** Plain nav links between the brand and the end slot. */
  links?: NavLink[]
  /** Mega-menus rendered alongside the plain links. */
  menus?: NavMenu[]
  /** Right-end slot of the top bar — typically `<UserMenu />`. */
  endSlot?: ReactNode
  /**
   * If provided, renders a panel-toggle button at the far left of the bar.
   * `<AppShell>` wires this automatically when an app passes a `drawer`.
   */
  onToggleDrawer?: () => void
  /** Current drawer open state — drives the toggle's icon + aria-pressed. */
  drawerOpen?: boolean
}

const BUTTON_BASE =
  'inline-flex items-center gap-1 rounded px-3 py-1.5 text-[11px] font-display uppercase tracking-wider transition-colors border'

const BUTTON_INACTIVE =
  'border-transparent text-t-text hover:bg-t-hover hover:text-t-bright'

const BUTTON_ACTIVE = 'border-t-accent/40 bg-t-accent/10 text-t-accent'

export function TopNav({
  appId,
  brandText = 'Omega',
  brandHref = '/',
  links = [],
  menus = [],
  endSlot,
  onToggleDrawer,
  drawerOpen,
}: TopNavProps) {
  return (
    <nav className="relative shrink-0 border-b border-t-border bg-t-surface">
      <div className="flex h-12 w-full items-center gap-8 px-6">
        {onToggleDrawer && (
          <button
            type="button"
            onClick={onToggleDrawer}
            aria-label={drawerOpen ? 'Hide sidebar' : 'Show sidebar'}
            aria-pressed={drawerOpen}
            className="grid h-8 w-8 shrink-0 place-items-center rounded text-t-muted transition-colors hover:bg-t-hover hover:text-t-bright"
          >
            {drawerOpen ? (
              <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
            ) : (
              <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        )}
        <a
          href={brandHref}
          className="font-display text-sm font-semibold uppercase tracking-[0.2em] text-t-bright transition-opacity hover:opacity-80"
        >
          {brandText}
        </a>

        {(links.length > 0 || menus.length > 0) && (
          <ul className="flex items-center gap-1">
            {links.map((link) => {
              const active = appId !== undefined && link.appId === appId
              return (
                <li key={link.label}>
                  <a
                    href={link.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(BUTTON_BASE, active ? BUTTON_ACTIVE : BUTTON_INACTIVE)}
                  >
                    {link.label}
                  </a>
                </li>
              )
            })}
            {menus.map((menu) => (
              <MegaMenu key={menu.label} menu={menu} appId={appId} />
            ))}
          </ul>
        )}

        {endSlot && <div className="ml-auto flex items-center gap-3">{endSlot}</div>}
      </div>
    </nav>
  )
}

function MegaMenu({ menu, appId }: { menu: NavMenu; appId?: AppId }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLLIElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const containedActive =
    appId !== undefined && (menu.containedAppIds?.includes(appId) ?? false)

  return (
    <li ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className={cn(
          BUTTON_BASE,
          containedActive || open ? BUTTON_ACTIVE : BUTTON_INACTIVE,
        )}
      >
        {menu.label}
        <ChevronDown
          aria-hidden="true"
          className={cn('h-3 w-3 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute left-0 top-[calc(100%+4px)] z-30 w-[420px] rounded border border-t-border bg-t-surface shadow-xl"
        >
          <div className="border-b border-t-border px-4 py-2">
            <div className="font-display text-[10px] font-semibold uppercase tracking-[0.2em] text-t-muted">
              {menu.label}
            </div>
          </div>
          <ul className="grid grid-cols-2 gap-1 p-2">
            {menu.items.map((item) => {
              const itemActive = appId !== undefined && item.appId === appId
              const baseItem =
                'flex flex-col gap-0.5 rounded px-3 py-2.5 transition-colors'

              if (item.disabled) {
                return (
                  <li key={item.label}>
                    <div
                      className={cn(baseItem, 'cursor-not-allowed opacity-50')}
                      aria-disabled="true"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-display text-xs font-semibold text-t-bright">
                          {item.label}
                        </span>
                        <span className="rounded-sm border border-t-border px-1.5 py-0.5 font-display text-[9px] font-semibold uppercase tracking-wider text-t-muted">
                          Soon
                        </span>
                      </div>
                      {item.description && (
                        <span className="text-[11px] leading-snug text-t-muted">
                          {item.description}
                        </span>
                      )}
                    </div>
                  </li>
                )
              }

              return (
                <li key={item.label}>
                  <a
                    href={item.href}
                    role="menuitem"
                    aria-current={itemActive ? 'page' : undefined}
                    onClick={() => setOpen(false)}
                    className={cn(
                      baseItem,
                      itemActive
                        ? 'bg-t-accent/10 text-t-accent'
                        : 'text-t-text hover:bg-t-hover hover:text-t-bright',
                    )}
                  >
                    <span
                      className={cn(
                        'font-display text-xs font-semibold',
                        itemActive ? 'text-t-accent' : 'text-t-bright',
                      )}
                    >
                      {item.label}
                    </span>
                    {item.description && (
                      <span className="text-[11px] leading-snug text-t-muted">
                        {item.description}
                      </span>
                    )}
                  </a>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </li>
  )
}
