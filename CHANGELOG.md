# Changelog

All notable changes to Omega are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Cloudflare Access JWT session middleware** in both `controller` and
  `chat-api`. When `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are both
  set, the session middleware verifies the CF Access JWT
  (`Cf-Access-Jwt-Assertion` header or `CF_Authorization` cookie) against
  the team's public JWKS, validates `aud` and `iss`, and identifies the
  user from the verified `email` and `sub` claims. `chat.users` is
  upserted by `cf_access_sub` so a user keeps the same row even if their
  email changes at the IdP. Required for any multi-tenant deploy — the
  prior single-user stub mapped every request to `DEFAULT_USER_EMAIL`,
  collapsing all CF-Access-authed users into one identity. The stub
  remains the default when CF Access env is absent, preserving the
  self-host UX where the operator provides perimeter auth. Setting only
  one of the two CF Access env vars is a misconfiguration and the
  process fails to start (closed-loud rather than silently dropping to
  the stub).
- **`apps/controller/goldens/README.md`** — operator playbook for
  publishing a new golden image. Walks through building the harness
  bundle, computing the manifest sha, registering in
  `pi.golden_images`, applying via `scripts/apply-golden.ts`, promoting
  across `alpha → beta → launch` channels, and retiring known-bad
  versions.
- **`apps/controller/goldens/example/manifest.json`** — illustrative
  manifest demonstrating the `default_skills` clause. Its
  `local_path` references the in-repo `apps/pi-harness/skills/` tree
  via relative path, so operators inherit the canonical skills set
  without copying it into their golden. Skills bundled this way land
  at `/home/sprite/skills/` and show up in Agent Mode's sidebar — the
  prior behavior (no `default_skills` clause anywhere) silently
  shipped sprites with 0 skills loaded.
- **`.gitignore` rule** for `apps/controller/goldens/*/` (excluding
  `example/`), so operator-published goldens stay in the operator's
  deploy repo and don't accidentally land in upstream commits.

## [0.6.0] - 2026-05-10

Filesystem RAG source + deploy plumbing envs. Self-hosted Omega deploys
(Helsinki, local dev) can now run RAG without per-user Google Drive
OAuth — they bind-mount a host directory and the ingest worker walks
it. Drive mode remains the default; existing deploys are unaffected by
the upgrade. The chat-frontend's Connectors pane adapts to whichever
mode the deploy picks via a new `/api/rag/source` probe.

In parallel, four optional build-time envs on `apps/chat-frontend` let
a deploy mount the SPA under a sub-path, point auth at a different
origin, wire Cloudflare Access logout, and (in dev) skip the `/api/me`
probe — closing the gap that previously forced 52L to ship a wrapper
App in its deploy repo. Three remaining hardcoded `Omega` strings in
chat-frontend components now read from `brand.name` so
`VITE_BRAND_NAME` controls every wordmark.

### Added

- **`RAG_SOURCE` env on `rag-api`** picks the ingest source: `drive`
  (default, unchanged behavior) or `filesystem` (new). A small
  `RagSource` interface in `apps/rag-api/ingest/src/source.ts` hides
  the source-specific logic from the rest of the crawler; lazy import
  via `pickSource()` means a filesystem-only deploy doesn't pay the
  googleapis startup cost.
- **`apps/rag-api/ingest/src/filesystem.ts`** — recursive directory
  walker with hardened safety rails: never follows symlinks (lstat
  check before opening), skips dotfiles, bounded walk depth (default
  16, `RAG_FILESYSTEM_MAX_DEPTH` override), resolves mime via
  extension lookup (no octet-stream guesses), per-file try/catch so a
  permission error doesn't kill the run. Path resolution on download
  rejects absolute ids and `..` escapes.
- **`apps/rag-api/migrations/0004_filesystem_source.sql`** — adds
  `source_kind` + `source_id` columns to `rag.files`, backfills drive
  rows (`source_kind='drive'`, `source_id=gdrive_file_id`), new unique
  index on `(tenant_id, source_kind, source_id)`. Relaxes
  `gdrive_file_id` to nullable so filesystem rows don't fake one. Adds
  `filesystem_status` to `rag.users` (analogous to
  `gdrive_my_ai_status`).
- **`GET /api/rag/source` on the controller** — ungated like
  `/enabled`. Returns `{ mode, features: { oauth, manual_ingest,
  shared_folder } }` so the chat-frontend can pick a Connectors-pane
  state machine on first paint. `features.oauth` is forced `false` in
  filesystem mode regardless of `ENABLE_GOOGLE_OAUTH`, so a stale
  frontend tab can't render Connect-Drive after a mode flip.
- **`apps/rag-api/api/src/routes/v1/users.ts` `/status` extension** —
  when `RAG_SOURCE=filesystem`, the response also carries
  `filesystem_status`, `filesystem_file_count`,
  `filesystem_last_walk_ts`. Drive-mode payloads are bit-identical to
  v0.5.x.
- **`<RAGSourceCard>` adaptive Connectors component** — replaces the
  v0.5.x drive-only `<DriveConnectCard>`. Dispatches to
  `<DriveConnectPane>` (renamed from `DriveConnectCard`, behavior
  unchanged) or `<FilesystemPane>` (new state machine:
  `loading → error | missing | empty | syncing | synced`) based on
  `/api/rag/source`. The actual filesystem path is **never rendered**
  in the UI — only counts and a "configured ✓" indicator.
- **`deploy/docker-compose.fs-rag.yml`** — new compose overlay. Layers
  on top of `docker-compose.{yml,rag.yml}` to flip the stack to
  filesystem mode and bind-mount `${RAG_FILES_HOST_DIR:-./rag-files}`
  read-only into rag-api and rag-ingest. Default host dir is
  `./rag-files` so a fresh clone "just works" — drop files into
  `deploy/rag-files/` and they get indexed.
- **`deploy/RAG.md` § "Filesystem source"** — full operator runbook:
  when to pick filesystem mode, layout + safety rails, compose
  wiring example, scp/sftp upload workflow with the recommended
  `omega-uploader` chrooted-sftp setup, status field reference, and a
  drive→filesystem migration recipe with the SQL to GC orphan drive
  rows.
- **Four chat-frontend deploy-plumbing envs** wired through
  `<App>` → `<AuthProvider>` props. All optional; defaults match a
  root-mounted SPA on the same origin as its API with no Cloudflare
  Access in front:
  - `VITE_BASE_PATH` — Vite `base` (SPA mount path, e.g. `/chat/`).
  - `VITE_API_BASE` — URL prefix `<AuthProvider>` uses for `/api/me`;
    decouples API path from SPA mount path.
  - `VITE_CF_ACCESS_TEAM_DOMAIN` — CF Access team domain; `signOut()`
    hits its `/cdn-cgi/access/logout`.
  - `VITE_DEV_FAKE_USER` — JSON-encoded `SessionUser` for local dev
    without a controller. **Dev-only** — production builds (where
    `import.meta.env.DEV` is false) ignore the env even if set.
- **`brand.name` in three remaining components.** `SignInScreen` badge,
  `ConnectGoogleScreen` badge, and `ChatDrawer` header now read from
  `brand.name` so `VITE_BRAND_NAME` controls every wordmark in the
  chat-frontend. No hardcoded `Omega` strings left.

### Changed

- **`apps/rag-api/ingest/src/crawler.ts`** is now source-agnostic. The
  Drive-specific `my-ai/` folder resolution + the deprecated
  `RAG_FOLDER_ALLOWLIST` fallback moved out of `crawler.ts` into
  `drive-source.ts`. Per-file dispatch goes through the `RagSource`
  interface. `rag.files` lookups now key on
  `(tenant_id, source_kind, source_id)` instead of
  `(tenant_id, gdrive_file_id)`. Cross-source bookkeeping (e.g.
  dropping `user_file_access` rows on a vanished file) is scoped to
  `source.kind` so a single-source crawl doesn't prune the other
  source's rows during a migration window.
- **`isIngestable` allowlist extracted** to
  `apps/rag-api/ingest/src/mime.ts`. Both Drive and filesystem sources
  share the same gate. `mime.ts` also exports a small extension-to-
  mime resolver used by the filesystem walker.
- **`<AppShell>` Connectors section** now embeds `<RAGSourceCard>`
  instead of `<DriveConnectCard>`. The old component is gone (renamed
  to `<DriveConnectPane>` and pulled into the card as the drive-mode
  body); the rendered DOM in drive mode is unchanged.

### Migration notes for existing deploys

- **`RAG_SOURCE` defaults to `drive`.** Existing 52L / Helsinki / OSS
  deploys keep the v0.5.x flow without a config change.
- **Migration 0004 runs on `rag-api` boot.** Non-destructive but
  irreversible: backfills `source_id` from `gdrive_file_id`, then
  relaxes `gdrive_file_id` to nullable. Safe on prod tables of any
  size we've seen (~thousands of rows).
- **`RAG_SOURCE=both` is explicitly rejected** at the worker. Reserved
  for a future release once cross-source dedup semantics are pinned.
- Drive-mode `/status` payload is bit-identical to v0.5.x; filesystem
  fields are omitted (not set to null) in drive mode.

## [0.5.1] - 2026-05-09

Bug fix: chat-frontend silently lost agent-mode state for users
upgrading from a 52L-built bundle that wrote the
`52l.chat.agentMode` localStorage key. v0.5.0 renamed the key prefix
to `omega.chat.*` but didn't carry forward existing values; a user
who had agent mode enabled would see it reset on first load.

### Fixed

- **`apps/chat-frontend/src/lib/agent-mode.ts`** migrates legacy
  `52l.chat.agentMode` localStorage entries into the new
  `omega.chat.agentMode` key on first read, then drops the legacy
  copy. Idempotent; tolerates missing values; safe in browsers without
  localStorage (SSR / private-tab paths).

## [0.5.0] - 2026-05-08

Frontend convergence + customization architecture. The OSS chat surface
gets a real shell — top nav, drawer toggle, mobile-responsive layout,
user dropdown — and a documented pattern for layering deployment-specific
content on top without forking the codebase.

### Added

- **Polished `<AppShell>`** with top nav, drawer toggle, user dropdown,
  and mobile-responsive layout. Replaces the prior 30-line stub. Brand
  text + href + nav links + mega-menus are all data-driven props with
  empty defaults — OSS deployments render brand-only nav, deployments
  populate via `<AppShell links={...} menus={...}>` or a runtime
  `navConfigUrl` fetch. New exports: `TopNav`, `useNavConfig`,
  `BUNDLED_NAV_CONFIG`, plus the `AppId`/`NavLink`/`NavMenu`/
  `MegaMenuItem` types.
- **`themeUrl` prop on `<AppShell>`** — fetches a theme JSON
  (`{ tokens: Record<string, string> }`) at runtime and applies the
  values as CSS custom properties on `document.documentElement`. Lets a
  deployment swap palettes without rebuilding the bundle. Token-name
  allowlist + value length cap prevent malformed payloads from injecting
  arbitrary CSS.
- **Build-time brand env vars on chat-frontend.** `VITE_BRAND_NAME`
  (default `Omega`) drives the wordmark in the top nav, page title, and
  empty-state badge; `VITE_BRAND_GLYPH` (default `Ω`) drives the
  assistant avatar and agent-mode banner. New `apps/chat-frontend/src/lib/brand.ts`
  reads them once at module load.
- **`<QuickActionsProvider>` for the chat empty state.** New
  `apps/chat-frontend/src/lib/quick-actions.tsx` exposes a
  Context+Provider+hook. Empty actions array as default — OSS empty
  state is just headline + tagline + composer. Deployments populate
  with a curated array of prompt cards + an `onSelect` handler.
- **`AuthProvider`** now exposes `signOut()` + `refresh()` and a
  `'loading'` status alongside the existing user/status surface.
  Required by the new `UserMenu` dropdown and matches the canonical
  shape needed for non-stub auth implementations.
- **`docs/CUSTOMIZATION.md`** — codifies the customization architecture
  forming through Phase 4: code goes upstream into Omega, configuration
  as data goes in your deploy. Documents the four data-delivery
  mechanisms (build-time env / runtime fetch / bind-mount JSON /
  Provider wrap), the currently-configurable surfaces, and the
  "wrap or contribute upstream, never fork" discipline.

### Changed

- The hardcoded `SUGGESTIONS` array on the chat empty state is gone.
  The cards (Qualify Sales Leads / Market Research / etc.) were
  prior-org placeholders that always rendered "Coming soon" toasts.
  Replaced with the data-driven `<QuickActionsProvider>` above.
- The chat-frontend's Tailwind `@source` directive now scans
  `@omega-inc/app-shell/src/**/*.{ts,tsx}` instead of a non-existent
  `dist/**/*.js`. Without this, utility classes used inside the shell
  package (drawer responsive layout, dropdown positioning, etc.)
  weren't getting compiled, which caused the drawer to render as a
  fixed bottom overlay instead of the responsive left aside.

### Fixed

- localStorage / sessionStorage keys renamed from the prior-org
  namespace `52l.chat.*` to `omega.chat.*`. Three sites:
  `provider-store` (selected provider/tier), `AgentActivityPanel`
  (panel open/closed), and `google-oauth` (skip-for-session flag).
  New `apps/chat-frontend/src/lib/storage.ts` adds a
  `readWithLegacyKey()` migration helper so existing users (notably
  Helsinki on prior versions) keep their preferences instead of
  resetting on the first load after the rename.
- `packages/shell/src/styles.css` was an empty placeholder that
  emitted nothing. Ported the canonical design-token block (Tailwind
  v4 `@theme` + `:root` CSS vars + a small set of `.t-*` utilities
  and scrollbar styling). Without this, every `bg-t-bright` /
  `text-t-text` / `border-t-border` class on the shell components
  emitted no CSS — drawer rendered with transparent backgrounds, user
  menu dropdown was invisible. Light theme, navy accent. Operators
  override any `--color-t-*` in `:root` after the `@import`.

## [0.4.2] - 2026-05-08

User-facing affordances for files in chat. The "Add file" button in
the drawer was the only path before; now drag-and-drop works and
uploads can be removed without starting a new chat.

### Added

- **Drag-and-drop into chat.** New `<ChatDropZone>` wraps the chat
  surface; drop a file anywhere on the chat tab and it uploads into
  the active session via the same path as the drawer's "Add file"
  button. Full-bleed overlay during drag for feedback. Uses the
  standard dragenter-counter pattern so cursor movement across nested
  child elements doesn't flicker the overlay.
- **Remove from uploads.** New `DELETE /uploads/:sessionId/:filename`
  route on the harness with the same path-traversal protection as
  `saveUpload` (`safeSessionId` + `safeFilename`). New
  `deleteUpload(filename)` on the chat-frontend `HarnessSession`
  context. The drawer's Uploads list now renders an X button on each
  row; idempotent (missing file → no error).

## [0.4.1] - 2026-05-08

Patch on top of v0.4.0. Fixes a silent gap that left the chat ↔ RAG
loop half-broken on the OSS docker path, and adds an operator
quickstart for standing up the full RAG stack.

### Fixed

- **DockerProvider now forwards `RAG_API_URL` + `RAG_SERVICE_TOKEN` to
  spawned pi-harness containers.** Without this, the harness's
  `rag_search` tool silently skipped registration even when the
  controller's `/api/rag/*` proxy worked — the chat surface looked
  half-wired (Settings card live, model couldn't actually search). The
  env-builder is now a pure function in `apps/controller/src/compute/env.ts`
  for testability.

### Added

- **`deploy/RAG.md`** — operator quickstart: bring up upstream RAGFlow,
  configure embedding provider, register the dataset link, wire
  chat ↔ RAG, smoke test. Includes Embedding model trade-offs,
  Gotchas list (DeepInfra base URL, `document_ids` constraint,
  refuse-to-walk-whole-Drive, parse failures), Disabling RAG, and a
  "Where to look when things break" walkthrough with SQL for the
  per-user state tables.
- **`deploy/docker-compose.rag.yml`** — overlay that adds the
  `rag-ingest` worker (missing from the base compose) and forwards
  the RAG env to the controller. Operator runs:
  `docker compose -f docker-compose.yml -f docker-compose.rag.yml up -d --build`.

## [0.4.0] - 2026-05-08

Chat ↔ RAG integration. Wires a working retrieval loop end-to-end:
operators point `RAG_API_URL` + `RAG_SERVICE_TOKEN` at a running rag-api
deployment, users connect their Drive from Settings → Connectors and run
a sync, and the model can call a `rag_search` tool inside the harness
sandbox to cite from the user's own indexed content.

### Added

- **`rag_search` tool in the pi-harness sandbox.** New AI SDK tool that
  POSTs `${RAG_API_URL}/api/v1/query` with the session's `user_id` and
  the controller-issued service bearer; returns retrieved chunks for
  the model to cite. Conditionally registered — only visible in the
  model's tool list when both `RAG_API_URL` and `RAG_SERVICE_TOKEN` are
  set on the harness env.
- **Controller `/api/rag/*` browser-facing proxy.** Four routes:
  `GET /api/rag/enabled` (feature flag, ungated), `POST /api/rag/sync`,
  `GET /api/rag/status`, `POST /api/rag/forget`. The user_id sent to
  rag-api is always pulled from the authenticated session — never from a
  request body field — so the browser can't impersonate another user.
  The service bearer is added on the server side; it never reaches any
  browser-bound payload.
- **Connect-Drive UX in chat-frontend.** New Settings → Connectors
  section with a six-state Drive card: loading-flag → disabled →
  needs-folder (instructions to create `my-ai/` in Drive) →
  never-synced → syncing (3s polling) → synced (file_count + relative
  time + Sync now / Forget). Self-gates on `/api/rag/enabled`, so OSS
  deployments without a RAG backend hide the card entirely.
- **`getRagConfig()` helper in the controller** (also lazy env reads,
  one-shot warning on half-set pairs). Used by the proxy routes;
  documented in `apps/controller/.env.example`.

### Notes for operators

To enable the full flow on an Omega deployment:

1. Stand up the rag-api stack (RAGFlow + ingest worker + API wrapper —
   see `apps/rag-api/` and migration `0003`).
2. Set `RAG_API_URL` and `RAG_SERVICE_TOKEN` on **both** the controller
   and the pi-harness env (the controller injects them into per-user
   sandboxes; for direct harness deploys set them yourself).
3. Set `RAG_KNOWLEDGE_BASE_FOLDER_ID` on the ingest worker to point at
   a shared Drive folder (optional). Per-user `my-ai/` folders are
   auto-discovered.
4. Open Settings → Connectors → Sync.

If `RAG_API_URL`/`RAG_SERVICE_TOKEN` are unset, all of the above is
silently disabled — the harness tool isn't registered, the controller
proxy 503s, and the frontend card hides itself.

## [0.3.0] - 2026-05-07

RAG ingest hardening. The worker is now safe to point at a real Drive
without bombing on the first oddly-shaped file or silently leaving
documents un-chunked. Operators with a `RAG_FOLDER_ALLOWLIST` config
should migrate to `RAG_PERSONAL_FOLDER_NAME` + `RAG_KNOWLEDGE_BASE_FOLDER_ID`
this release; the legacy env still works with a deprecation warning and
will be removed in v0.4.0.

### Added

- **Per-user `my-ai/` folder** auto-discovery. Each user's personal
  ingest folder is resolved on first sync (`drive.files.list` with
  `'me' in owners`), cached on the user row, and never re-resolved
  unless the chat side bumps status back. Folder name is configurable
  via `RAG_PERSONAL_FOLDER_NAME` (default: `my-ai`).
- **Shared knowledge-base folder** via `RAG_KNOWLEDGE_BASE_FOLDER_ID`
  — single folder ID applied to every user. Per-user OAuth permissions
  filter what each user actually sees inside it.
- `GET /api/v1/users/:id/status` now returns `my_ai_folder_status`
  (`unknown` | `present` | `missing`) so the chat-side UI can prompt
  the user to create their personal folder when missing.
- Migration `0003_my_ai_folder.sql`: adds `gdrive_my_ai_folder_id`,
  `gdrive_my_ai_status` to `rag.users`.

### Changed

- `GET /api/v1/users/:id/status` returns **404** for unknown user_ids
  instead of silently auto-creating a `rag.users` row. The auto-create
  caused a phantom-user retry loop the chat side hit during 404 polls.
  `/sync` is now the only endpoint that creates a row.
- The RAGFlow client (`apps/rag-api/ingest/src/ragflow.ts`) now treats
  envelope errors as failures. RAGFlow returns `200 OK` with a non-zero
  envelope `code` on parse-step failures (e.g. `KeyError('id')`); the
  client previously swallowed those as success and the docs sat at
  `run: UNSTART, chunks: 0` forever, breaking retrieval.
- `RAGFLOW_BASE_URL` and `RAGFLOW_API_KEY` are now read lazily per call
  instead of captured at module load (eager-const trap).
- Crawler's per-file ingest is now wrapped in `try/catch`. A transient
  Drive 5xx, an export size limit, or a single RAGFlow upload rejection
  no longer aborts the whole crawl.
- The crawler **refuses to whole-Drive walk**. With both
  `RAG_FOLDER_ALLOWLIST` empty and no personal/shared folder, the job
  fails with a clear `last_error` instead of hammering Drive.

### Fixed

- Crawler skips Google native types we don't have an exporter for
  (Drawings, Forms, Apps Scripts, Shortcuts, Sites, My-Maps). These
  used to fall through to `drive.files.get(alt: 'media')` and abort
  the entire crawl with `Only files with binary content can be
  downloaded`.
- The crawler no longer silent-catches RAGFlow parse-step failures.
  A failed parse now surfaces as a failed sync job with the error in
  `rag.users.last_error`.

### Deprecated

- `RAG_FOLDER_ALLOWLIST` — replaced by per-user `my-ai/` +
  `RAG_KNOWLEDGE_BASE_FOLDER_ID`. Still respected for one release with
  a console warning. Will be removed in v0.4.0.

## [0.2.0] - 2026-05-07

### Changed

- **Operator scripts are now env-driven** (breaking for anyone using
  `apps/controller/scripts/{provision,update}-user.ts` from v0.1.0).
  `PASS_VAULT_NAME` is now required; per-secret pass-cli item titles are
  configurable via `PASS_ITEM_*` env vars; conventional env vars
  (`ANTHROPIC_API_KEY`, `HARNESS_JWT_SECRET`, etc.) override pass-cli
  lookup when set. Defaults no longer include any prior-org-specific
  prefixes. See `apps/controller/scripts/README.md`.
- Scrubbed prior-org references from comments and docs throughout
  (`README.md`, `deploy/fly.md`, `packages/shell/src/AuthProvider.tsx`,
  `apps/chat-frontend/src/components/{ProviderBar,MarkdownBlock}.tsx`).
- Replaced the assistant avatar badge text in
  `apps/chat-frontend/src/components/assistant-ui/thread.tsx` with the
  glyph `Ω`.

### Added

- README "Status" line declaring the maintenance posture.
- `apps/controller/scripts/README.md` documenting the env surface.

### Fixed

- `chat-frontend`: `POST /api/session/start` now retries on `409 Conflict`
  with exponential backoff (1.5s, 4s) when two browser tabs / signins race
  the controller's per-user provisioning. Previously the second caller
  surfaced the 409 to the user as a session-start failure.

## [0.1.0] - 2026-05-03

Initial public alpha release. Tagged as [`v0.1.0`](https://github.com/Logos-Flux/Omega/releases/tag/v0.1.0).

### Added

- Initial Omega stack: `chat-api` (Bun + Hono streaming chat with AI SDK v5),
  `chat-frontend` (React 19 + Vite + assistant-ui SPA served by Caddy),
  `controller` (sandbox orchestrator with pluggable `ComputeProvider`),
  `pi-harness` (Bun WebSocket agent runtime with `/workspace`, skills, and
  per-user provider keys), and `rag-api` (RAGFlow wrapper + per-user GDrive
  ingest worker).
- `packages/shell` (`@omega-inc/app-shell`) — minimal layout + auth stubs
  consumed by `chat-frontend`.
- Two `ComputeProvider` implementations: `docker` (single-machine, mounts
  `/var/run/docker.sock`) and `sprites` ([Fly Sprites](https://sprites.dev)).
- One-shot local stack via `deploy/docker-compose.yml`; recipes for Proxmox
  LXC and multi-app Fly deploys.
- Optional Google OAuth (Drive + Calendar + Gmail per user), gated by
  `ENABLE_GOOGLE_OAUTH=true` on the controller.

### Tested

- Restored test suite covering `chat-api`, `controller`, and `pi-harness`
  (158 tests across the three apps).
- End-to-end `docker compose up` smoke test passes against the OSS build.

[0.1.0]: https://github.com/Logos-Flux/Omega/releases/tag/v0.1.0
