    ██╗      ██████╗  ██████╗  ██████╗ ███████╗
    ██║     ██╔═══██╗██╔════╝ ██╔═══██╗██╔════╝
    ██║     ██║   ██║██║  ███╗██║   ██║███████╗
    ██║     ██║   ██║██║   ██║██║   ██║╚════██║
    ███████╗╚██████╔╝╚██████╔╝╚██████╔╝███████║
    ╚══════╝ ╚═════╝  ╚═════╝  ╚═════╝ ╚══════╝

            ███████╗██╗     ██╗   ██╗██╗  ██╗
            ██╔════╝██║     ██║   ██║╚██╗██╔╝
            █████╗  ██║     ██║   ██║ ╚███╔╝ 
            ██╔══╝  ██║     ██║   ██║ ██╔██╗ 
            ██║     ███████╗╚██████╔╝██╔╝ ██╗
            ╚═╝     ╚══════╝ ╚═════╝ ╚═╝  ╚═╝
# Omega

Open-source agent chat stack: streaming chat API, assistant-ui frontend, sandbox
compute orchestrator, **pi-harness** agent runtime, and a RAG service. Apache-2.0.

> **Status:** Apache-2.0, single-maintainer. PRs welcome; support is best-effort.

```
┌──────────────┐  /api/*           ┌──────────────┐
│ chat-frontend│ ───────────────▶  │  chat-api    │  HTTP streaming chat (AI SDK v7)
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
bun test                       # run the full test suite (431 tests across 47 files)
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
├── chat-api/         Bun + Hono chat backend (AI SDK v7 streaming)
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

### Agent Mode web search

The pi-harness agent can search the public web and read pages through
[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp),
using Fast mode for search without a Parallel account or API key. Results include
source URLs for citations. Queries and requested URLs are sent to Parallel;
private documents belong in the existing upload, Drive or RAG tools.

Set `WEB_SEARCH_PROVIDER` in the **pi-harness process environment**:

| Value | Behavior |
|---|---|
| `auto` (default) | Keep native search when the selected Anthropic/Gemini provider has a configured API key, when Gemini File Search is configured, or when using Perplexity Sonar. Otherwise use Parallel. |
| `parallel` | Expose `web_search` and `web_fetch` with Anthropic, Gemini or DeepSeek. |
| `native` | Keep the selected model provider's search tools. DeepSeek has no native web search. |
| `none` | Omit harness web tools. This cannot disable search built into Perplexity Sonar. |

For Docker or Sprites, include the setting in your harness image or per-user
runtime environment; setting it only on the controller does not forward it.
Existing model selections and credentials stay in place. Parallel does not
replace a failed native search automatically. Persona `tools_denied` and
invocation `toolsDenied` can deny `web_search` (including `google_search`) and
`web_fetch`. Anonymous service limits and errors are returned to the agent;
each call has a 30-second deadline and follows turn cancellation.

### Other optional features

- **Google OAuth** (Drive + Calendar + Gmail per user) is opt-in: set
  `ENABLE_GOOGLE_OAUTH=true` on the controller and configure
  `GOOGLE_OAUTH_CLIENT_ID/SECRET`. Disabled by default.
- **MCP server** — the original closed-source deploy used the Cloudflare-specific
  `agents/mcp` adapter. Porting to the Node MCP SDK is on the roadmap.
- **OAuth-mediated RAG ingest** — `apps/rag-api/ingest/` runs per-user
  Drive crawls. Requires either a static refresh token (`OAUTH_PROVIDER=env`)
  or the controller's token-mint endpoint (`OAUTH_PROVIDER=controller`,
  needs `ENABLE_GOOGLE_OAUTH=true`).

## License

[Apache-2.0](./LICENSE) — see [`NOTICE`](./NOTICE).
