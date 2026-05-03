# Deploy Omega to Fly.io

Four Fly apps on a shared Postgres cluster. Optional: Fly Sprites for the
pi-harness compute layer (the `SpritesProvider` was the original 52L
production deploy; the OSS `DockerProvider` is the default).

| Component | Fly app slug | Why |
|---|---|---|
| Postgres | `<your-pg>` | Shared by chat-api + controller |
| chat-api | `<your-chat-api>` | Streaming chat HTTP API |
| controller | `<your-controller>` | Sandbox orchestrator |
| chat-frontend | `<your-chat-frontend>` | SPA + Caddy proxy |
| rag-api | `<your-rag-api>` (optional) | RAG wrapper, if you run RAGFlow |

## 1. Provision Postgres

```bash
flyctl postgres create --name <your-pg> --region iad --vm-size shared-cpu-1x --volume-size 1
# Note the Connection URL — both chat-api and controller use it.
```

## 2. Pick a compute provider

The controller needs to spawn per-user pi-harness sandboxes. On Fly there
are two paths:

- **Sprites** (the 52L production path). Set `COMPUTE_PROVIDER=sprites`
  and `SPRITES_API_TOKEN`. Sprites lives in beta; sign up at
  <https://sprites.dev>.
- **Docker on a sidecar host.** Run a small box (Hetzner, AWS lightsail,
  a Proxmox LXC) with Docker exposed via a TLS-protected daemon socket.
  Set `COMPUTE_PROVIDER=docker` + `DOCKER_SOCKET=tcp://<your-host>:2376`.

For self-contained Fly deploys the Docker path is awkward (Fly Machines
can't expose a daemon to other machines). Sprites is the path of least
resistance on Fly.

## 3. Deploy controller

```bash
cd apps/controller
cp fly.toml.example fly.toml
sed -i 's/<your-controller>/your-controller/' fly.toml

flyctl apps create your-controller --org personal

flyctl secrets set \
  DATABASE_URL='postgres://...'                             \
  HARNESS_JWT_SECRET="$(openssl rand -hex 32)"              \
  ADMIN_BEARER_TOKEN="$(openssl rand -hex 32)"              \
  CONTROLLER_SERVICE_TOKEN="$(openssl rand -hex 32)"        \
  COMPUTE_PROVIDER=sprites                                  \
  SPRITES_API_TOKEN='...'                                   \
  ANTHROPIC_API_KEY='...'                                   \
  GOOGLE_API_KEY='...'                                      \
  PERPLEXITY_API_KEY='...'                                  \
  -a your-controller

flyctl deploy
```

## 4. Deploy chat-api

```bash
cd apps/chat-api
cp fly.toml.example fly.toml
sed -i 's/<your-chat-api>/your-chat-api/' fly.toml

flyctl apps create your-chat-api --org personal

flyctl secrets set \
  DATABASE_URL='postgres://...'    \
  ANTHROPIC_API_KEY='...'          \
  GOOGLE_API_KEY='...'             \
  PERPLEXITY_API_KEY='...'         \
  -a your-chat-api

flyctl deploy
```

## 5. Deploy chat-frontend

```bash
cd apps/chat-frontend
cp fly.toml.example fly.toml
sed -i 's/<your-chat-frontend>/your-chat-frontend/' fly.toml

flyctl apps create your-chat-frontend --org personal

flyctl secrets set \
  CHAT_API_UPSTREAM='https://your-chat-api.fly.dev'        \
  CONTROLLER_UPSTREAM='https://your-controller.fly.dev'    \
  -a your-chat-frontend

flyctl deploy
```

Open `https://your-chat-frontend.fly.dev/` — the SPA loads, `/api/*` hits
chat-api, `/api/controller/*` hits the controller.

## 6. (Optional) rag-api

Only run rag-api if you have a RAGFlow instance somewhere reachable.
Point `RAGFLOW_BASE_URL` at it.

```bash
cd apps/rag-api/api
cp fly.toml.example fly.toml
sed -i 's/<your-rag-api>/your-rag-api/' fly.toml

flyctl apps create your-rag-api --org personal

flyctl secrets set \
  DATABASE_URL='postgres://...'                             \
  RAGFLOW_BASE_URL='https://...'                            \
  RAGFLOW_API_KEY='...'                                     \
  ADMIN_BEARER_TOKEN="$(openssl rand -hex 32)"              \
  -a your-rag-api

flyctl deploy
```

## 7. Auth (out of scope on Fly)

Omega's OSS build doesn't ship app-level auth. On Fly the cleanest options:

- **Cloudflare Access** in front of `your-chat-frontend.fly.dev` (or
  whatever custom domain you map). Single Access app, group-gated.
- **oauth2-proxy** as a sidecar machine on Fly, terminating sessions and
  forwarding to the chat-frontend.
- **Tailscale serve** with `--public=false`, restricting access to your
  tailnet.

The 52L production deploy (the precursor to this OSS release) used
Cloudflare Access — the JWKS-verifying middleware is in git history if
you want to restore it on top of the OSS branch.

## 8. CI/CD

Add a `FLY_API_TOKEN` (`flyctl tokens create deploy`) repo secret and a
GitHub Actions workflow per app:

```yaml
- uses: superfly/flyctl-actions/setup-flyctl@master
- run: flyctl deploy --remote-only -c apps/chat-api/fly.toml
  env:
    FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```
