import { useAuth } from './AuthProvider'

interface UserMenuProps {
  settingsHref?: string
  onSettings?: () => void
}

export function UserMenu({ settingsHref, onSettings }: UserMenuProps) {
  const { user } = useAuth()
  const initial = (user?.name ?? user?.email ?? '?').charAt(0).toUpperCase()

  const handleClick = onSettings
    ? (e: React.MouseEvent<HTMLAnchorElement>) => {
        if (settingsHref) {
          e.preventDefault()
          onSettings()
        }
      }
    : undefined

  if (!settingsHref) {
    return (
      <button
        type="button"
        className="flex h-7 w-7 items-center justify-center rounded-full bg-t-card text-xs font-semibold text-t-bright"
        title={user?.email ?? 'Account'}
      >
        {initial}
      </button>
    )
  }

  return (
    <a
      href={settingsHref}
      onClick={handleClick}
      className="flex h-7 w-7 items-center justify-center rounded-full bg-t-card text-xs font-semibold text-t-bright hover:bg-t-hover"
      title={user?.email ?? 'Account'}
    >
      {initial}
    </a>
  )
}
