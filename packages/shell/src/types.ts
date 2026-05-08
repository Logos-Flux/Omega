/**
 * App identifier for active-state highlighting in the top nav. Operators
 * pick their own ids — `<AppShell appId="chat">` matches against the
 * `appId` field on each nav link to highlight the active button.
 *
 * Kept as a plain `string` (rather than a closed union) so OSS deployments
 * can use whatever app names they want without a type-level rebuild.
 */
export type AppId = string

/**
 * One link in the top nav middle section. Plain links render as a button
 * pointing at `href`; mega-menu items belong to a `MegaMenuItem` instead.
 */
export interface NavLink {
  /** Display label */
  label: string
  /** Destination URL */
  href: string
  /** Match against `<AppShell appId>` to set the active state */
  appId?: AppId
}

/**
 * One item inside a mega-menu (the dropdown that opens off a nav button).
 * Same shape as a NavLink but with optional description + a `disabled`
 * flag that greys the item out and shows a "Soon" tag.
 */
export interface MegaMenuItem {
  label: string
  href: string
  appId?: AppId
  description?: string
  disabled?: boolean
}

/**
 * A mega-menu attached to a top-nav button. Click the button → dropdown
 * with the listed `items`. Multiple menus can sit alongside plain links
 * in the nav middle section.
 */
export interface NavMenu {
  /** Button label that opens the menu */
  label: string
  /**
   * App ids that — when active — should keep this menu's button
   * highlighted (because the active app lives under the menu).
   */
  containedAppIds?: AppId[]
  items: MegaMenuItem[]
}
