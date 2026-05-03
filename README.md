# Omega

Open-source agent chat stack: streaming chat API, assistant-ui frontend, sandbox
compute orchestrator, **pi-harness** agent runtime, and a RAG service. Apache-2.0.

```
┌──────────────┐  /api/*           ┌──────────────┐
│ chat-frontend│ ───────────────▶  │  chat-api    │  HTTP streaming chat (AI SDK v5)
│  (SPA + Caddy)│                  └──────────────┘
│              │  /api/controller/*┌──────────────┐  /docker.sock          ┌──────────────┐
│              │ ───────────────▶  │  controller  │ ─────────────────────▶ │  pi-harness  │
└──────────────┘                   └──────────────┘  spawns per-user box   │  (one per    │
                                                                          │   user)      │
                                                                          └──────────────┘
                                   ┌──────────────┐
                                   │  rag-api     │  RAGFlow wrapper + GDrive ingest
                                   └──────────────┘
```

`chat-api` does the simple "talk to a model" flow. The **agent** lives in the
`pi-harness` — a long-running Bun WebSocket server inside a sandbox container,
with persistent `/workspace` storage, skills, and the same provider keys.
The `controller` provisions one harness per user via a pluggable
`ComputeProvider` (Docker locally, [Fly Sprites](https://sprites.dev) in
the cloud).

## Quick start (Docker)

```bash
git clone https://github.com/Logos-Flux/Omega.git
cd Omega/deploy

# Bring your own provider keys.
cat > .env <<EOF
ANTHROPIC_API_KEY=...
GOOGLE_API_KEY=...
PERPLEXITY_API_KEY=...
HARNESS_JWT_SECRET=$(openssl rand -hex 32)
EOF

docker compose up --build
```

Open <http://localhost:8080/>.

The compose stack pre-builds the pi-harness image so the controller can spawn
it via the Docker daemon socket. Check `docker ps` after sending a message in
Agent Mode — you'll see a `harness-<short-userid>` container appear.

## Development

Working on Omega locally:

```bash
bun install                    # install all workspace deps
bun test                       # run the full test suite (158 tests across apps)
bun --cwd apps/chat-api tsc --noEmit   # per-app typecheck (substitute any app)
```

Each app has its own `.env.example` documenting the env surface it consumes —
copy it to `.env` in that app and fill in values:

- [`apps/chat-api/.env.example`](./apps/chat-api/.env.example)
- [`apps/chat-frontend/.env.example`](./apps/chat-frontend/.env.example)
- [`apps/controller/.env.example`](./apps/controller/.env.example)
- [`apps/pi-harness/.env.example`](./apps/pi-harness/.env.example)
- [`apps/rag-api/api/.env.example`](./apps/rag-api/api/.env.example)
- [`apps/rag-api/ingest/.env.example`](./apps/rag-api/ingest/.env.example)

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution workflow,
[SECURITY.md](./SECURITY.md) for vulnerability reporting, and
[CHANGELOG.md](./CHANGELOG.md) for release notes.

## Repository layout

```
apps/
├── chat-api/         Bun + Hono chat backend (AI SDK v5 streaming)
├── chat-frontend/    React 19 + Vite + assistant-ui SPA, Caddy-served
├── controller/       Sandbox orchestrator (ComputeProvider = sprites|docker)
├── pi-harness/       Bun WS server that lives inside each user's sandbox
└── rag-api/          RAGFlow wrapper + per-user GDrive ingest
    ├── api/          HTTP wrapper
    └── ingest/       BullMQ-style ingest worker

packages/
└── shell/            @omega-inc/app-shell — minimal layout + auth stubs

deploy/
├── docker-compose.yml      One-shot local stack
├── proxmox-lxc.md          Recipe for Docker-in-LXC + native split
└── fly.md                  Multi-app Fly deploy (Sprites or external Docker)
```

## Auth (out of scope)

Omega doesn't ship app-level auth. Operators wrap the deployment with their
own — common picks:

- **oauth2-proxy** in front of Caddy
- **Caddy basic auth** for a quick passcode
- **Tailscale serve** to expose only to your tailnet
- **Cloudflare Access** with a self-hosted Access application

The middleware files (`apps/chat-api/src/middleware/session.ts`,
`apps/controller/src/middleware/session.ts`) ship as single-user stubs that
upsert a `chat.users` row keyed on `DEFAULT_USER_EMAIL`. Replace those with
your own auth verifier when you need multi-user.

## Threat model (the short version)

A few trust assumptions worth knowing before you point Omega at the public
internet:

- **The operator brings the edge auth.** The OSS build has no app-level
  authentication; anyone who can reach `chat-api` or the controller can use
  them. Front the deployment with one of the options listed in
  [Auth](#auth-out-of-scope) above.
- **The controller has the host's keys.** In the Docker provider, the
  controller mounts `/var/run/docker.sock`, which is effectively root on the
  host. Treat the controller process accordingly: don't expose it directly,
  don't run untrusted code in it, and prefer the [Sprites](https://sprites.dev)
  provider when running multi-tenant.
- **No built-in rate limiting.** Add it at the edge proxy if you care about
  abuse or runaway model spend. The provider keys live in the controller's
  env, so a chatty client can burn them.

## Compute providers

The `ComputeProvider` interface is in
[`apps/controller/src/compute/types.ts`](./apps/controller/src/compute/types.ts).
Two impls ship:

| Provider | When | Configuration |
|---|---|---|
| `docker` (default) | Single-machine deploys | Mount `/var/run/docker.sock` into the controller; set `HARNESS_IMAGE` (default `omega-pi-harness:local`) |
| `sprites` | [Fly Sprites](https://sprites.dev) | `COMPUTE_PROVIDER=sprites` + `SPRITES_API_TOKEN` |

Want Proxmox / Kubernetes / Firecracker / something else? Implement the
four-method interface and submit a PR. The controller selects providers
by env (`COMPUTE_PROVIDER`) so adding a new one doesn't touch any routes.

## Optional features

- **Google OAuth** (Drive + Calendar + Gmail per user) is opt-in: set
  `ENABLE_GOOGLE_OAUTH=true` on the controller and configure
  `GOOGLE_OAUTH_CLIENT_ID/SECRET`. Disabled by default.
- **MCP server** — the original 52L deploy used the Cloudflare-specific
  `agents/mcp` adapter. Porting to the Node MCP SDK is on the roadmap.
- **OAuth-mediated RAG ingest** — `apps/rag-api/ingest/` runs per-user
  Drive crawls. Requires either a static refresh token (`OAUTH_PROVIDER=env`)
  or the controller's token-mint endpoint (`OAUTH_PROVIDER=controller`,
  needs `ENABLE_GOOGLE_OAUTH=true`).

## Status

This is **v0.1.0 — initial alpha release.** The code is the production
stack the precursor (`52Launch-Inc/*`) ran in private; the OSS build
strips all 52Launch-specific identifiers, swaps Cloudflare Access for a
single-user stub, and adds Docker as a first-class compute provider.
Expect rough edges; PRs welcome.

## License

[Apache-2.0](./LICENSE) — see [`NOTICE`](./NOTICE).
