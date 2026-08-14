# Omega — Agent Notes

Open-source agent chat stack (Apache-2.0). This file orients an AI coding agent
working in the repo. It **complements, not repeats** the prose docs — read those
first, then use this as the terse map + gotchas:

- `README.md` — architecture diagram, quick start, threat model, compute providers, optional features
- `CONTRIBUTING.md` — contribution workflow, code style, PR rules
- `deploy/` — deploy recipes (`docker-compose.yml`, `fly.md`, `proxmox-lxc.md`, `RAG.md`)
- `docs/CUSTOMIZATION.md` — theming / branding
- `CHANGELOG.md` — release notes; `SECURITY.md` — vulnerability disclosure

## Layout (Bun workspace monorepo)

```
apps/
├── chat-api/      Bun + Hono streaming chat backend (AI SDK v7)
├── chat-frontend/ React 19 + Vite + assistant-ui SPA, Caddy-served
├── controller/    Sandbox orchestrator (one pi-harness per user)
├── pi-harness/    Bun WS server that runs INSIDE each user's sandbox
└── rag-api/       RAGFlow wrapper (api/) + per-user GDrive ingest (ingest/)

packages/
└── shell/         @omega-inc/app-shell — shared layout + auth-stub package
```

Key facts an agent should hold:

- **chat-api** does the plain "talk to a model" flow. Multi-provider routing lives in
  `apps/chat-api/src/lib/providers.ts`. SQL migrations are applied **at boot** from
  `migrations/*.sql` in lexical order — keep them idempotent / `IF NOT EXISTS`-safe.
- **controller** provisions one harness per user through the `ComputeProvider` seam
  (`apps/controller/src/compute/types.ts`): `docker` (default) or `sprites`. Selection is
  by the `COMPUTE_PROVIDER` env var — adding a provider should not touch any route.
- **pi-harness** is the actual agent runtime: a long-running Bun WebSocket server inside a
  per-user sandbox container with persistent `/workspace`, skills, and provider keys. It
  ships as a **golden bundle baked into the compute image, NOT a standalone Fly image** —
  don't try to deploy it on its own.
- **chat-frontend** theming is deploy-time (see `docs/CUSTOMIZATION.md`) and follows the
  shared `t-*` design-token contract; never hardcode colors — use the token classes.

## Commands

```bash
bun install                          # workspace install — all apps + packages/shell (bun.lock is TRACKED)
bun test                             # full suite — run before every PR
bun --cwd apps/<app> tsc --noEmit     # per-app typecheck (substitute any app)
git config core.hooksPath .githooks  # enable the pre-push hook ONCE per clone
```

- Use **Bun**, never npm/npx. **TypeScript everywhere** — no JS in source.
- The **pre-push hook** (`.githooks/pre-push`) runs the CI typecheck matrix + `bun test`
  before any push. It is **not** auto-enabled on clone — run the `git config` above once.
  Bypass a single push with `git push --no-verify`.

## Conventions & gotchas

- **Env surface is per-app.** Each app has its own `.env.example` listing exactly what it
  consumes — copy it to `.env` in that app. A new provider key, env var, or migration
  MUST be added to the relevant `.env.example` in the same PR.
- **Auth is the operator's job.** The OSS build ships single-user session **stubs**
  (`apps/chat-api/src/middleware/session.ts`, `apps/controller/src/middleware/session.ts`)
  that upsert a user row on `DEFAULT_USER_EMAIL`. Replace them with your own verifier for
  multi-user, and front the deployment with edge auth (see README → "Auth"). Don't
  introduce a new auth strategy without an issue discussion first.
- **Never trust a `userId` from the request body.** Handlers use the session-derived id
  (`c.get('user').id`) as the silo key for all per-user data.
- **Adding a compute provider:** implement the four-method `ComputeProvider` interface
  (`ensureContainer` / `freeze` / `destroy` / `status`), register it behind a new
  `COMPUTE_PROVIDER` value in `compute/index.ts`, and add a README row. Gate
  Docker-dependent tests behind `OMEGA_E2E=1` so CI without a daemon stays green.
- **Deploy from a pinned/tagged ref, not a working tree.** Use the `deploy/` recipes;
  don't deploy a service straight from a dirty checkout.

## Optional features (off by default)

- **Google OAuth** (Drive / Calendar / Gmail per user): set `ENABLE_GOOGLE_OAUTH=true` on
  the controller + `GOOGLE_OAUTH_CLIENT_ID/SECRET`.
- **OAuth-mediated RAG ingest** (`apps/rag-api/ingest/`): per-user Drive crawls; needs a
  static refresh token (`OAUTH_PROVIDER=env`) or the controller's token-mint endpoint
  (`OAUTH_PROVIDER=controller`, requires `ENABLE_GOOGLE_OAUTH=true`).
