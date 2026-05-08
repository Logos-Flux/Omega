# RAG operator quickstart

How to stand up Omega's Drive-backed retrieval feature end-to-end.

After this is wired the user can: open Settings → Connectors → Sync,
then ask the assistant a question whose answer lives in their `my-ai/`
Drive folder, and see the model call `rag_search` and cite the chunks.

## What you're standing up

```
Browser ── /api/controller/api/rag/* ──▶ Controller ── HTTP+bearer ──┐
                                                                     │
Harness rag_search tool ── HTTP+bearer ──────────────────────────────┤
                                                                     ▼
                                                  ┌──────────────────────────┐
                                                  │ rag-api  (this repo)     │
                                                  │  · Postgres `rag.*`      │
                                                  │  · RAGFlow client        │
                                                  └──────────────────────────┘
                                                              │
                                                              ▼
                                                  ┌──────────────────────────┐
                                                  │ RAGFlow (upstream)       │
                                                  │  · MySQL  · Infinity     │
                                                  │  · embedding provider    │
                                                  └──────────────────────────┘
                                                              ▲
                                                              │ uploads
                                                  ┌──────────────────────────┐
                                                  │ rag-ingest (this repo)   │
                                                  │  · per-user Drive crawl  │
                                                  └──────────────────────────┘
```

Two repos contribute pieces:

- **Omega** (this repo): the `rag-api` wrapper + the `rag-ingest` worker
  in `apps/rag-api/`, the controller proxy at `/api/rag/*`, the
  `rag_search` harness tool, and the Connect-Drive UX.
- **[RAGFlow](https://ragflow.io)** (upstream, separate stack): the
  retrieval engine itself — does chunking, embedding, vector search.
  Omega doesn't fork or vendor it; we run upstream containers and
  configure them via env + API.

## Prerequisites

- Omega is already running locally via `deploy/docker-compose.yml`. If
  not, start there — the base stack doesn't need RAG to work.
- Docker + `docker compose` available.
- An embedding provider account: DeepInfra, OpenAI, Together, or a
  self-hosted TEI / Ollama. See [Embedding model](#embedding-model)
  for the trade-offs.
- (For per-user Drive ingest) A Google OAuth client with `drive.readonly`
  scope. See `apps/controller/.env.example` `ENABLE_GOOGLE_OAUTH`.

## Step 1 — Bring up RAGFlow

The simplest path is upstream RAGFlow's published `docker-compose-base.yml`.
From a working directory **outside** Omega:

```bash
git clone --depth 1 --branch v0.21.1 https://github.com/infiniflow/ragflow.git
cd ragflow/docker
docker compose -f docker-compose.yml up -d
```

This brings up RAGFlow + MySQL + Elasticsearch + MinIO + Redis on the
default ports. The web UI lives at <http://localhost:80>.

> **Tip for limited resources:** RAGFlow's `-slim` image variant skips
> the bundled embedding/reranker models and is ~3 GB instead of ~9 GB.
> Use `infiniflow/ragflow:v0.21.1-slim` if you're using a managed
> embedding host (DeepInfra, OpenAI, etc.) and don't need on-box GPU
> models.

Health check from your terminal:

```bash
curl -sf http://localhost:9380/v1/system/status && echo " RAGFlow ok"
```

## Step 2 — Configure RAGFlow

Open <http://localhost:80> in a browser:

1. **Create an admin account** (first user to register).
2. **Settings → Model providers**: add your embedding provider.
   - DeepInfra: provider type `OpenAI-API-Compatible`, base URL
     `https://api.deepinfra.com/v1` (note: NOT `/v1/openai`), model
     `BAAI/bge-m3`, paste your DeepInfra API key.
   - See [Gotchas](#gotchas) below for the base-URL footgun.
3. **Knowledge → Create knowledge base.** Pick a name (e.g.
   `omega-default`). Choose your embedding model. Note the dataset
   shows in the URL bar as `?id=<uuid>` after you click into it —
   that's the `ragflow_dataset_id` you'll need in step 4.
4. **Settings → API keys**: create a service API key. Copy it; it's
   shown once. This becomes `RAGFLOW_API_KEY` in step 3.

## Step 3 — Wire Omega's rag-api + ingest worker

Add the RAG add-on overlay to your existing Omega compose invocation:

```bash
cd /path/to/Omega/deploy
docker compose -f docker-compose.yml -f docker-compose.rag.yml up -d --build
```

The overlay adds a `rag-ingest` service (the per-user Drive crawl
worker) alongside the `rag-api` already in the base. Both share the
Postgres + Redis from the base stack.

Set the following env vars (in `deploy/.env` next to `docker-compose.yml`):

```bash
# Required for RAG
RAGFLOW_BASE_URL=http://host.docker.internal:9380
RAGFLOW_API_KEY=<the key from step 2.4>

# Generate with `openssl rand -hex 32`. This token is what the
# controller and harness will send as their service bearer.
RAG_ADMIN_BEARER_TOKEN=

# (Optional) Per-tenant ingest scope. Per-user `my-ai/` folders are
# auto-discovered; this is the shared knowledge-base folder ID, same
# for every user. Leave blank to skip the shared root.
RAG_KNOWLEDGE_BASE_FOLDER_ID=

# (Optional) Override the personal folder name. Default: my-ai
RAG_PERSONAL_FOLDER_NAME=my-ai
```

Restart the stack so the new env reaches both services.

## Step 4 — Register the dataset link

Omega keeps its own `rag.datasets` table that maps each tenant to one
RAGFlow knowledge-base id. The migration seeded the `omega` tenant on
boot; you need to drop in the dataset row yourself. Once:

```bash
docker compose exec postgres psql -U omega -d omega -c "
  INSERT INTO rag.datasets (tenant_id, ragflow_dataset_id)
  SELECT id, '<the dataset id from step 2.3>' FROM rag.tenants WHERE slug = 'omega'
  ON CONFLICT DO NOTHING;
"
```

Verify:

```bash
docker compose exec postgres psql -U omega -d omega -c "
  SELECT t.slug, d.ragflow_dataset_id FROM rag.tenants t JOIN rag.datasets d ON d.tenant_id = t.id;
"
```

You should see one row.

## Step 5 — Wire chat ↔ RAG

Add to `deploy/.env`:

```bash
# Same value as RAG_ADMIN_BEARER_TOKEN above. The controller and
# harness use this to authenticate to rag-api.
RAG_API_URL=http://rag-api:3100
RAG_SERVICE_TOKEN=<same as RAG_ADMIN_BEARER_TOKEN>
```

These get propagated into the controller and (via the controller's
sandbox spawn config) into each per-user pi-harness container.
Restart the stack again.

## Step 6 — Smoke test

```bash
# 1. Feature flag — should report enabled=true.
curl -sf http://localhost:8080/api/controller/api/rag/enabled

# 2. End-to-end via the UI:
#    Open http://localhost:8080/, sign in.
#    Settings → Connectors → "Sync Drive".
#    Watch the card flip from "never-synced" → "syncing…" → "X files
#    indexed · last synced just now".
#    Back to chat: ask a question whose answer is in your my-ai/
#    folder. The assistant should call rag_search and cite the file
#    name in its reply.
```

If the card shows "needs-folder" first, create a folder named `my-ai`
in your Drive root, drop a few files in it, click Retry.

## Embedding model

This is a **lock-in** decision: RAGFlow stores the embedding model
identity per dataset, so changing it after you've ingested anything
means re-embedding the whole corpus. Pick once, deliberately.

**Default recommendation:** `BAAI/bge-m3` via DeepInfra. 1024-dim,
8K input, dense + sparse + ColBERT in one forward pass — pairs
unusually well with RAGFlow's hybrid retrieval. ~$0.010 / M tokens
on DeepInfra (validated 2026-05).

Other reasonable picks:

| Provider | Model | Notes |
|---|---|---|
| **Together AI** | `intfloat/multilingual-e5-large-instruct` | Different vector space than bge-m3; switching means re-embed |
| **OpenAI** | `text-embedding-3-small` | Cheap, fine quality, 1536-dim |
| **TEI** (self-hosted) | any HF embedding model | Full control, GPU-bound |
| **Ollama** (self-hosted) | `nomic-embed-text` | CPU-friendly, ~768-dim |

## Gotchas

- **DeepInfra base URL is `/v1`, not `/v1/openai`.** RAGFlow's
  OpenAI-API-Compatible plugin appends `/embeddings` to the base; with
  `/v1/openai` it constructs `/v1/openai/v1/embeddings` and 404s.
  Both `https://api.deepinfra.com/v1/embeddings` and
  `https://api.deepinfra.com/v1/openai/embeddings` work on DeepInfra
  itself, but RAGFlow needs the shorter base.
- **`document_ids` requires the same embedding model across the listed
  docs.** Per RAGFlow's API doc. We have one dataset per tenant, so
  this is satisfied today. Splitting into multiple datasets per tenant
  later means tracking the per-dataset embedding model.
- **Migrations run on boot.** `apps/rag-api/api` runs all SQL files in
  `apps/rag-api/migrations/` on startup, in lexical order, in a
  transaction each. No manual `psql` step is needed for the schema.
- **`ADMIN_BEARER_TOKEN` seeds itself.** Setting `RAG_ADMIN_BEARER_TOKEN`
  in your `.env` is enough — `apps/rag-api/api/src/lib/seed.ts` upserts
  the sha256 hash into `rag.api_keys` on every boot. Same value works
  as `RAG_SERVICE_TOKEN` on the controller / harness.
- **Per-user `my-ai/` folder is owner-only.** The crawler restricts
  the lookup to `'me' in owners`, so a folder shared *with* the user
  by someone else won't match. If users want to point at someone
  else's folder, use the shared `RAG_KNOWLEDGE_BASE_FOLDER_ID` instead.
- **Crawler refuses to whole-Drive walk.** With both
  `RAG_FOLDER_ALLOWLIST` empty and no personal/shared folder, the job
  fails with a clear `last_error` instead of dumping the user's entire
  Drive into the index.
- **Parse step failures surface as failed jobs.** If RAGFlow returns
  `200 OK` but a non-zero envelope `code` from the parse trigger
  (`/api/v1/datasets/<id>/chunks`), the worker marks the sync job
  failed and writes the error to `rag.users.last_error`. The chat-side
  Connect-Drive card will show it. Earlier versions silently swallowed
  these as success and queries 500'd later with `KeyError('id')`.
- **Switching embedding models after ingest is expensive.** RAGFlow
  records the embedding model identity per dataset — changing it
  requires re-embedding every doc. Switching the *host* of the same
  model is free (vectors are model-identical regardless of host).

## Disabling RAG

Both pieces of the wiring contract self-disable when env is missing:

- Unset `RAG_API_URL` + `RAG_SERVICE_TOKEN` on the controller and
  harness → the `/api/rag/*` proxy 503s, the `rag_search` tool
  isn't registered, and the Connect-Drive card hides itself.
- Unset `RAGFLOW_API_KEY` on rag-api → the rag-api boots but every
  upload errors with a clear "RAGFLOW_API_KEY not set" message.

There's no kill-switch beyond unset env. The feature is opt-in by
configuration, not by feature flag.

## Where to look when things break

- **Controller logs** — `docker compose logs -f controller` — auth
  failures, `/api/rag/*` proxy errors.
- **rag-api logs** — `docker compose logs -f rag-api` — bearer
  resolution, dataset lookup, RAGFlow envelope errors.
- **rag-ingest logs** — `docker compose logs -f rag-ingest` — per-file
  download/upload failures, Drive folder lookup, RAGFlow parse
  trigger.
- **RAGFlow's own UI** — `http://localhost/`, the Knowledge Base
  shows per-doc parse status. `run: DONE, chunk_num: > 0` means
  retrieval will work for that doc.
- **`rag.users` and `rag.sync_jobs` tables** — the source of truth for
  per-user sync state. `last_error` on `rag.users` is what the chat-
  side card surfaces.

For per-user state debugging:

```sql
SELECT id, chat_user_id, gdrive_my_ai_status, last_synced_at, last_error
  FROM rag.users;

SELECT id, user_id, status, finished_at, files_seen, files_changed, error
  FROM rag.sync_jobs ORDER BY created_at DESC LIMIT 10;
```
