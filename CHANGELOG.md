# Changelog

All notable changes to Omega are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
