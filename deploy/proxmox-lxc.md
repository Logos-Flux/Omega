# Deploy Omega to Proxmox LXC

Two reasonable layouts:

1. **Docker-in-LXC** (simplest) — one privileged LXC with nesting + keyctl
   enabled, run `docker compose up` from `deploy/`. Same shape as the
   docker-compose flow on a laptop.
2. **One LXC per service** — split chat-api, controller, pi-harness,
   chat-frontend, rag-api, postgres, and redis into separate LXCs. Talk
   over a tailnet. Works well if you already have those services hosted
   elsewhere and want to slot new services in.

This file documents (1). For (2), copy the Dockerfiles and adapt them
into systemd units per LXC; the dependencies between services are env
vars (`DATABASE_URL`, `CHAT_API_UPSTREAM`, etc.), not networking magic.

## 1. Create the container

From the Proxmox host:

```bash
pct create 220 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname omega \
  --memory 4096 \
  --cores 2 \
  --rootfs local-lvm:20 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --features nesting=1,keyctl=1 \
  --start 1
```

`nesting=1 + keyctl=1` are required so Docker can run inside the LXC.

## 2. Install Docker + clone

```bash
pct enter 220
apt-get update && apt-get install -y curl ca-certificates git
curl -fsSL https://get.docker.com | sh
git clone https://github.com/Logos-Flux/Omega.git /opt/omega
cd /opt/omega/deploy
```

## 3. Provider keys + secrets

Drop a `.env` next to `docker-compose.yml`:

```bash
cat > /opt/omega/deploy/.env <<EOF
ANTHROPIC_API_KEY=...
GOOGLE_API_KEY=...
PERPLEXITY_API_KEY=...
HARNESS_JWT_SECRET=$(openssl rand -hex 32)
EOF
chmod 600 /opt/omega/deploy/.env
```

Compose picks these up automatically.

## 4. Bring up the stack

```bash
cd /opt/omega/deploy
docker compose up -d --build
docker compose ps
```

Smoke test:

```bash
curl -s http://localhost:3000/healthz   # chat-api
curl -s http://localhost:3001/healthz   # controller
curl -s http://localhost:3100/healthz   # rag-api (if running)
curl -s http://localhost:8080/          # chat-frontend (Caddy)
```

## 5. Updates

```bash
cd /opt/omega
git pull
cd deploy
docker compose up -d --build
docker compose ps
```

## 6. Public hostname (optional)

Run Caddy on the Proxmox host (or upstream of the LXC) and reverse-proxy
to the LXC's IP:

```caddy
chat.example.com {
    reverse_proxy <lxc-ip>:8080
}
```

Caddy on the host will provision a Let's Encrypt cert. The LXC's
`chat-frontend` keeps serving HTTP on `:8080` behind it.

## Resource notes

- **4 GB / 2 cores / 20 GB disk** runs the full stack with headroom.
- Postgres and Redis volumes live on Docker named volumes (`pgdata`,
  `redisdata`). They survive `docker compose down`; use `docker compose down -v`
  to nuke them.
- The pi-harness containers spawned by the controller live on the same
  Docker network as the rest of the stack. They claim random host ports
  (`docker ps` to see them).
