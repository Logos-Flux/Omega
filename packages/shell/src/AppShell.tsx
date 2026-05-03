import { type ReactNode } from 'react'

interface AppShellProps {
  children: ReactNode
  drawer?: ReactNode
  topNavEndSlot?: ReactNode
  /** Reserved — kept for API parity with hosted shells. */
  appId?: string
}

export function AppShell({ children, drawer, topNavEndSlot, appId }: AppShellProps) {
  return (
    <div className="flex h-screen flex-col bg-t-deep text-t-text">
      <header
        className="flex h-12 shrink-0 items-center justify-between border-b border-t-border bg-t-surface px-4"
        data-app-id={appId}
      >
        <div className="text-sm font-display tracking-tight text-t-bright">Omega</div>
        <div className="flex items-center gap-2">{topNavEndSlot}</div>
      </header>
      <div className="flex min-h-0 flex-1">
        {drawer ? (
          <aside className="w-64 shrink-0 overflow-y-auto border-r border-t-border bg-t-card">
            {drawer}
          </aside>
        ) : null}
        <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  )
}
