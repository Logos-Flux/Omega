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

A future release will add `themeUrl` (runtime JSON load) and a Settings
→ Appearance picker.

### RAG (chat ↔ retrieval)

Set `RAG_API_URL` + `RAG_SERVICE_TOKEN` on the controller and harness.
With both set, the controller's `/api/rag/*` proxy mounts and the
harness's `rag_search` tool registers. With either unset, both
silently disable. See `deploy/RAG.md`.

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
