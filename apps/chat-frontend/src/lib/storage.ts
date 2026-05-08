// Tiny helper for reading a Web Storage value with a one-shot
// migration from a legacy key. Used during the v0.5.0 namespace
// rename from `52l.chat.*` → `omega.chat.*` so existing users don't
// see their provider choice / panel-collapsed state reset on the
// first load after the update.
//
// Idempotent: once the legacy value has been migrated, subsequent
// calls just return the new key directly.

export function readWithLegacyKey(
  store: Storage,
  newKey: string,
  legacyKey: string,
): string | null {
  const current = store.getItem(newKey)
  if (current !== null) return current
  const legacy = store.getItem(legacyKey)
  if (legacy === null) return null
  store.setItem(newKey, legacy)
  store.removeItem(legacyKey)
  return legacy
}
