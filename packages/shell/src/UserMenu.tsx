import { useEffect, useRef, useState } from 'react'
import { Settings, LogOut } from 'lucide-react'
import { cn } from './lib/cn'
import { useAuth } from './AuthProvider'

export interface UserMenuProps {
  /**
   * Where the "Settings" item points. Apps own their own settings route.
   * Defaults to `/settings`. Pass an absolute URL to point elsewhere.
   */
  settingsHref?: string
  /**
   * Optional click handler for "Settings". If provided, takes precedence
   * over `settingsHref` (the menu calls preventDefault on the link).
   */
  onSettings?: () => void
}

export function UserMenu({
  settingsHref = '/settings',
  onSettings,
}: UserMenuProps) {
  const { user, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

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

  if (!user) return null

  const initials =
    (user.name ?? user.email)
      .split(/\s+|@/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase())
      .join('') || '?'

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={user.name ?? user.email}
        className={cn(
          'rounded-full transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-t-accent/50',
          open && 'ring-2 ring-t-accent/40',
        )}
      >
        {user.picture ? (
          <img
            src={user.picture}
            alt=""
            referrerPolicy="no-referrer"
            className="h-7 w-7 rounded-full object-cover"
          />
        ) : (
          <span className="grid h-7 w-7 place-items-center rounded-full bg-t-accent text-[10px] font-display font-semibold text-white">
            {initials}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-60 rounded border border-t-border bg-t-surface shadow-lg"
        >
          <div className="border-b border-t-border px-3 py-2.5">
            <div className="font-display text-xs font-semibold text-t-bright truncate">
              {user.name ?? user.email}
            </div>
            {user.name && (
              <div className="text-[11px] text-t-muted truncate">{user.email}</div>
            )}
          </div>

          <a
            href={settingsHref}
            role="menuitem"
            onClick={(e) => {
              if (onSettings) {
                e.preventDefault()
                setOpen(false)
                onSettings()
              }
            }}
            className="flex items-center gap-2 px-3 py-2 text-xs text-t-text hover:bg-t-hover hover:text-t-bright"
          >
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />
            Settings
          </a>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              signOut()
            }}
            className="flex w-full items-center gap-2 border-t border-t-border px-3 py-2 text-left text-xs text-t-text hover:bg-t-hover hover:text-t-bright"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
