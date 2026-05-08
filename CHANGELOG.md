# Changelog

All notable changes to Omega are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
