# Customization

How to tailor an Omega deployment without forking, and survive future
upstream updates without merge pain.

## TL;DR

**Code goes upstream into Omega. Configuration as data goes in your
deploy.** Every customization point in Omega is a prop, env var, or
runtime URL with an empty/stub default. To customize, you populate
those hooks from your deploy artifacts — you do not edit Omega source.

If you find yourself wanting to edit a component to add deployment-
specific UI or data, that's the signal to add a prop or env to Omega
upstream and populate it in your deploy. The PR pays for itself the
first time you take an Omega update.

## Three layers, two repos

```
┌─────────────────────────────────────────────────────────────────────┐
│  Omega (this repo, public)                                          │
│  Generic structure. Empty defaults for everything that varies.      │
│  No customer-specific data, branding, or copy lives here.           │
└────────────────────────────┬────────────────────────────────────────┘
                             │ tagged release pulled at deploy time
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  <your-org>-deploy (private, per-organization)                      │
│  Just config + data — never source code or forked components.       │
│   - .env files (provider keys, hostnames, secrets)                  │
│   - JSON files (nav-config, quick-actions, theme tokens)            │
│   - Compose overrides (restart policies, edge config)               │
└─────────────────────────────────────────────────────────────────────┘
```

## How customization data reaches the running app

Pick whichever shape fits the data:

| Mechanism | Use for | Example |
|---|---|---|
| **Build-time env var** (`VITE_*` for the frontend, `process.env.*` for backends) | Single values you don't change at runtime — brand name, palette identifier, feature flag | `VITE_BRAND_NAME=Omega` |
| **Runtime fetch** (URL prop on a component) | Larger arrays / objects you want to update without redeploys | `<AppShell navConfigUrl="https://nav.example.com/nav.json">` |
| **Bind-mounted JSON** (compose volume mount) | Medium-complexity data shipped with the deploy | mount `./quick-actions.json` into the `chat-frontend` container, fetch it from a static path |
| **React Provider in your wrapper app** | When you want type-safe data + a custom click handler | Wrap `<ChatPage />` with `<QuickActionsProvider actions={...} onSelect={...}>` |

## Currently configurable surfaces

These are the customization points Omega exposes today. Empty / no-op
defaults in OSS; populate per-deployment.

### Top navigation (`@omega-inc/app-shell`)

```tsx
<AppShell
  brandText="Acme"                 // default: "Omega"
  brandHref="/"                    // default: "/"
  links={[
    { label: 'Home',  href: '/home', appId: 'home' },
    { label: 'Chat',  href: '/chat', appId: 'chat' },
  ]}
  menus={[
    { label: 'Marketing', items: [/* MegaMenuItem[] */] },
  ]}
  // …or fetch the same shape at runtime:
  navConfigUrl="https://nav.example.com/nav.json"
>
  …
</AppShell>
```

OSS default: brand "Omega", no links, no menus → just brand + drawer
toggle + user menu.

### Quick-action cards on the chat empty state

```tsx
import { QuickActionsProvider } from './lib/quick-actions'

<QuickActionsProvider
  actions={[
    { id: 'leads',    label: 'Qualify Sales Leads', description: '…' },
    { id: 'research', label: 'Market Research',     description: '…', badge: 'Beta' },
  ]}
  onSelect={(action) => insertPrompt(action.label)}
>
  <ChatPage />
</QuickActionsProvider>
```

OSS default: empty array → cards don't render, empty state is just
headline + tagline + composer.

### Brand identity

Build-time env on `apps/chat-frontend`:

```bash
VITE_BRAND_NAME=Acme        # wordmark + page title + empty-state badge
VITE_BRAND_GLYPH=A          # single character used as the assistant avatar
```

OSS defaults: `Omega` / `Ω`. Vite inlines these into the bundle, so
rebuilding the frontend is required to change them.

The top-nav uses the same value automatically (`<AppShell brandText={brand.name}>`
in `App.tsx`).

### Deploy plumbing

Build-time envs on `apps/chat-frontend` that adapt the SPA to a deploy's
edge / auth setup without forking. All optional — defaults match a
root-mounted SPA on the same origin as its API, with no Cloudflare Access
in front.

| Env | What it does | Default |
|---|---|---|
| `VITE_BASE_PATH` | Vite `base` — SPA mount path. Set to `/chat/` to serve at `https://example.com/chat/`. Trailing slash required. | `/` |
| `VITE_API_BASE` | URL prefix `<AuthProvider>` uses for `/api/me`. Empty string forces same-origin no-prefix even when the SPA is mounted under a sub-path. Unset falls back to the SPA mount path. | unset → SPA mount path |
| `VITE_CF_ACCESS_TEAM_DOMAIN` | Cloudflare Access team domain (e.g. `https://example.cloudflareaccess.com`). Used by `signOut()` to clear the CF session via `/cdn-cgi/access/logout`. | unset → `signOut()` just reloads |
| `VITE_DEV_FAKE_USER` | JSON-encoded `SessionUser`; `<AuthProvider>` skips `/api/me` and authenticates as this user. **Honored only in dev builds** (`import.meta.env.DEV`); production builds ignore it. | unset |

Typical mappings:

- **OSS dev**: leave all unset; `bun run dev` proxies `/api/*` to a
  local chat-api on port 3000.
- **Single-host deploy** (Helsinki-style): leave all unset; the edge
  serves SPA + API on the same origin.
- **Sub-path deploy** (e.g. `chat.example.com/chat/`): set
  `VITE_BASE_PATH=/chat/`. Set `VITE_API_BASE=` (empty) when the API
  is mounted at `/api/*` (not `/chat/api/*`).
- **Behind Cloudflare Access**: set `VITE_CF_ACCESS_TEAM_DOMAIN` so the
  user-menu sign-out actually clears the session.

### Theme

Override any `--color-t-*` variable in `:root` after the app-shell
import:

```css
@import "tailwindcss";
@import "@omega-inc/app-shell/styles.css";

:root {
  --color-t-deep:   #0c0f1d;     /* dark theme */
  --color-t-bright: #f4f5f8;
  --color-t-accent: #ff5a4e;
}
```

For runtime theme swaps without rebuilding, pass a `themeUrl` to
`AppShell`:

```tsx
<AppShell themeUrl="https://themes.example.com/midnight.json">
```

The endpoint should return JSON shaped like:

```json
{
  "name": "Midnight",
  "tokens": {
    "color-t-deep":   "#0c0f1d",
    "color-t-bright": "#f4f5f8",
    "color-t-accent": "#9b8cff"
  }
}
```

Token values are applied as `document.documentElement.style` CSS
custom properties after the bundled defaults paint. Token keys are
plain CSS variable names (no leading `--`); only ASCII names matching
`/^[a-zA-Z][a-zA-Z0-9_-]*$/` are applied (so a malformed payload can't
inject arbitrary properties).

A future release will add a Settings → Appearance picker that browses
a registry of themes.

### RAG (chat ↔ retrieval)

Set `RAG_API_URL` + `RAG_SERVICE_TOKEN` on the controller and harness.
With both set, the controller's `/api/rag/*` proxy mounts and the
harness's `rag_search` tool registers. With either unset, both
silently disable. See `deploy/RAG.md`.

**Source mode (v0.6.0+).** `RAG_SOURCE` picks the ingest source. The
controller and rag-ingest worker both read it; values must match.

| Value | Behavior |
|---|---|
| `drive` (default) | Per-user Google Drive crawl. Requires `ENABLE_GOOGLE_OAUTH=true` on the controller plus a Google OAuth client. |
| `filesystem` | Recursive walk of `RAG_FILES_DIR` bind-mounted into rag-ingest. No OAuth. Bring up with `deploy/docker-compose.fs-rag.yml` layered on top of the base + RAG overlays. |

The chat-frontend's Settings → Connectors card auto-adapts via
`/api/rag/source` — drive mode renders the existing Connect-Drive UX,
filesystem mode renders a path-anonymised "RAG content" pane with the
same Sync now / Forget controls. See `deploy/RAG.md` § "Filesystem
source (alternative to Drive)" for the full filesystem-mode runbook
(operator workflow, sftp setup, drive→filesystem migration).

## When customization needs new UI structure

Sometimes "what we need" can't be expressed as data — it's a new
component, a new flow, a structural change. Two right answers, in
priority order:

1. **Contribute upstream behind a prop / feature flag.** Add the
   structure to Omega itself with an opt-in switch. OSS ships off by
   default; your deploy turns it on. Phase 4's app-shell port is the
   archetype: 52L's polished top nav was added to OSS as a config-
   driven structure with empty defaults.

2. **Wrap, don't fork.** If the structure is genuinely org-specific
   and doesn't make sense upstream, your deploy can wrap Omega's
   components in a thin operator-side layer. Import `<ChatPage />`
   from the package, render it inside your own header/footer.
   Updating Omega is still a version bump; your wrapper rides
   along untouched.

What you should *not* do: edit Omega's source files in your deploy
checkout. Every Omega update will conflict with your edits, and
"merging" upstream becomes a manual chore instead of a tag bump.

## When in doubt

Open an issue (or a draft PR) on Omega itself. "Here's what my
deployment needs; should this be a prop, an env, a runtime URL, or
something else?" The answer is almost always one of those — the
codebase already has dozens of examples of each shape, and a quick
discussion before implementation saves a re-architecture later.
