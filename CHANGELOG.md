# Changelog

All notable changes to Omega are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
