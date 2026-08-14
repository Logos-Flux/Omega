// Extracted from SettingsPage.tsx (PERF-03) so <App /> can decide whether the
// settings route is active WITHOUT statically importing the (large) SettingsPage
// module — that module is now React.lazy'd. Keeping this check here means the
// route decision costs nothing at boot.

/** True when the current path is `${BASE_URL}settings(/...)`. */
export function isSettingsPath(): boolean {
  if (typeof window === 'undefined') return false
  const base = import.meta.env.BASE_URL
  const path = window.location.pathname
  return path === `${base}settings` || path.startsWith(`${base}settings/`)
}
