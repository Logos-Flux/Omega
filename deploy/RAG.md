# RAG operator quickstart

How to stand up Omega's retrieval feature end-to-end.

Two ingest sources are available, picked by the `RAG_SOURCE` env:

- **`drive`** (default) — per-user Google Drive crawl. Each user
  authorises Omega to read their `my-ai/` folder; an optional shared
  knowledge base folder is crawled for everyone. Requires Google
  OAuth. **The bulk of this guide covers this path.**
- **`filesystem`** — recursive walk of an operator-managed host
  directory bind-mounted into rag-ingest. No OAuth required. Better
  fit for self-hosted single-tenant deploys where the operator wants
  to curate the corpus directly. See [Filesystem source (alternative
  to Drive)](#filesystem-source-alternative-to-drive) below.

After this is wired (in either mode) the user can open Settings →
Connectors → Sync, then ask the assistant a question whose answer lives
in the indexed corpus, and see the model call `rag_search` and cite the
chunks.

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

## Parser config

RAGFlow's per-dataset `parser_config` controls what happens between
"upload" and "embed". Defaults are aggressive — fine for an evaluation
demo, painful for a self-host:

| Option | Default | Cost |
|---|---|---|
| `layout_recognize` | `DeepDOC` | Heavy OCR + vision pipeline. ~30-60 min on a 480-page PDF. Holds ~15 GB RSS while running. |
| `graphrag.use_graphrag` | `true` | Extra LLM pass per doc to extract an entity graph. Multiplies token spend. |
| `raptor.use_raptor` | `true` | Hierarchical clustering + LLM summarization per cluster. Multiplies token spend again. |

For text-heavy docs (PDFs, markdown, plain text) the **Plain Text**
parser is roughly 100x faster and gives essentially identical retrieval
quality, because RAGFlow's chunker + the embedding model do the real
work either way.

**Recommended self-host default** — set at dataset creation or via the
update API:

```bash
curl -X PUT -H "Authorization: Bearer $RAGFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  http://$RAGFLOW_HOST/api/v1/datasets/$DATASET_ID \
  -d '{
    "parser_config": {
      "layout_recognize": "Plain Text",
      "chunk_token_num": 512,
      "delimiter": "\n",
      "graphrag": { "use_graphrag": false },
      "raptor": { "use_raptor": false },
      "auto_keywords": 0,
      "auto_questions": 0,
      "topn_tags": 3,
      "html4excel": false
    }
  }'
```

Notes:

- The change applies to **future uploads**. Documents already in the
  dataset retain the parser_config they had at upload time. To re-parse
  with the new config, delete the doc + re-upload (the worker walks the
  filesystem source on the next sync and re-ingests).
- When you do want DeepDOC — e.g. forms, tables, scanned PDFs where
  layout matters — budget at least 16 GB RAM for the RAGFlow stack and
  expect parse times of minutes per page. Run it on a separate machine
  from your interactive workload if you can.
- `graphrag` and `raptor` are independently useful for some retrieval
  patterns. They're disabled here because they multiply LLM cost without
  obviously improving the "answer this question from documents" baseline.
  Re-enable selectively if you're optimising for graph-style queries.

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

## Filesystem source (alternative to Drive)

Available since v0.6.0. Picks an operator-managed host directory
instead of per-user Google Drive. **Defaults are unchanged** — leave
`RAG_SOURCE` unset (or `drive`) and existing deploys keep the v0.5.x
flow.

### When to pick filesystem mode

- You're self-hosting for a single user or small team and would
  rather curate the corpus by `cp`-ing files into a directory than
  per-user Drive consent flows.
- You don't have a Google Workspace and don't want one.
- You want air-gapped retrieval — no outbound Drive calls.
- You're running locally for development and a real Drive isn't
  available.

### Layout (v0.6.0)

Flat. Every file under `RAG_FILES_DIR` is visible to every user in the
tenant. The walk is recursive but skips:

- dotfiles and dot-directories (`.git/`, `.DS_Store`, …)
- symlinks (security invariant — never followed; use real files)
- files with unknown extensions (resolved via filename, not magic
  bytes; see `apps/rag-api/ingest/src/mime.ts` for the allowlist)
- directories deeper than `RAG_FILESYSTEM_MAX_DEPTH` (default 16)

Per-user subdirs (one directory per user, plus a `_shared/` peer)
are deferred to v0.7.x as `RAG_FILESYSTEM_LAYOUT=per-user`. The DB
schema (`source_id` as a relative path) supports both layouts without
migration churn — the layout is just walk semantics.

### Wiring (compose overlay)

A new overlay `deploy/docker-compose.fs-rag.yml` flips both `rag-api`
and `rag-ingest` to filesystem mode and bind-mounts the host
directory:

```bash
# In your deploy/.env:
RAG_SOURCE=filesystem
RAG_FILES_HOST_DIR=/path/to/your/rag-files
RAGFLOW_BASE_URL=http://host.docker.internal:9380
RAGFLOW_API_KEY=<from RAGFlow Settings → API keys>
RAG_ADMIN_BEARER_TOKEN=<openssl rand -hex 32>
RAG_API_URL=http://rag-api:3100
RAG_SERVICE_TOKEN=<same as RAG_ADMIN_BEARER_TOKEN>

# Bring the stack up with all three overlays:
cd deploy
docker compose -f docker-compose.yml \
               -f docker-compose.rag.yml \
               -f docker-compose.fs-rag.yml \
               up -d --build
```

The `RAG_FILES_HOST_DIR` defaults to `./rag-files` (relative to the
compose project), so a fresh clone "just works" — drop test files into
`Omega/deploy/rag-files/` and they get indexed.

Steps 2 (RAGFlow setup) and 4 (dataset link) are unchanged — RAGFlow
is the same in either mode. Step 3 (wire Omega's services) is replaced
by the compose invocation above. Step 6 (smoke test) is unchanged
except the Connectors card now shows "RAG content" instead of "Google
Drive" and reports a file count from the host directory.

### Operator workflow

There's no web upload UI in v0.6.0 — the lightest mechanism that gets
files indexed:

```bash
# Local dev:
cp ~/Downloads/policies.pdf Omega/deploy/rag-files/

# Helsinki / remote:
scp ./policies.pdf omega-uploader@helsinki:/var/lib/omega/rag-files/
```

After a file lands in the directory, hit **Sync now** in Settings →
Connectors. The walk picks it up; RAGFlow parses + embeds; the
assistant can cite from it on the next query.

A v0.7.x follow-on adds an in-app upload UI that drops files into the
same directory via a small server-side endpoint. Not needed for v0.6.0.

### Helsinki sftp setup

For a public deploy where the operator uploads via sftp rather than
exec'ing into the host, recommended pattern (v0.6.0):

1. Create user `omega-uploader` on the host (snoochie CT 130 in our
   case), primary group `omega-uploader`. Add the operator's SSH
   public key to its `~/.ssh/authorized_keys`.
2. ```bash
   sudo install -d -o omega-uploader -g omega-uploader -m 2750 /var/lib/omega/rag-files
   ```
   The setgid bit (`2`) makes new uploads inherit the group so the
   rag-ingest container (read-only volume) can read them.
3. Optionally chroot the user to that directory by adding to
   `/etc/ssh/sshd_config`:
   ```
   Match User omega-uploader
       ChrootDirectory /var/lib/omega/rag-files
       ForceCommand internal-sftp
       AllowTcpForwarding no
   ```
   Note: chroot requires the directory to be root-owned with `0755`.
   If you chroot, keep the upload-target subdirectory underneath (e.g.
   `/var/lib/omega/rag-files/incoming/`) with `omega-uploader`-owned
   permissions.
4. Set `RAG_FILES_HOST_DIR=/var/lib/omega/rag-files` in the compose
   `.env`. The `:ro` flag on the bind-mount in
   `docker-compose.fs-rag.yml` means rag-ingest can't modify or delete
   uploaded files.

### Status fields

In filesystem mode the `/api/v1/users/:id/status` response carries
extra fields:

| Field | Meaning |
|---|---|
| `filesystem_status` | `'present'` (operator has provisioned the source dir), `'missing'` (per-user-subdir layout only), `'unknown'` (default in flat layout) |
| `filesystem_file_count` | Count of `source_kind='filesystem'` rows in the user's `user_file_access` |
| `filesystem_last_walk_ts` | Most recent finished filesystem-source crawl (`MAX(last_indexed_at)`) |

These are omitted (not null) on drive-mode payloads so 52L's response
shape is unchanged.

### Migrating drive → filesystem

Migration 0004 (shipped with v0.6.0) is a one-way relax: existing
drive rows in `rag.files` get backfilled `source_kind='drive'` and a
new unique key on `(tenant_id, source_kind, source_id)`. Filesystem
rows can coexist; they leave `gdrive_file_id` NULL.

Switching a live deploy from drive to filesystem mode:

1. Land migration 0004 (happens automatically on next rag-api boot —
   see "Migrations run on boot" in [Gotchas](#gotchas)).
2. Stop rag-ingest, populate `RAG_FILES_DIR` with the content you want
   indexed, set `RAG_SOURCE=filesystem` and `RAG_FILES_HOST_DIR` in
   `.env`.
3. Bring the stack back up with `docker-compose.fs-rag.yml` overlaid.
4. Existing drive rows stay in the DB and remain queryable until
   someone runs `/api/rag/forget` to GC them. To clear them in bulk
   without per-user forget calls, run:
   ```sql
   DELETE FROM rag.user_file_access a
     USING rag.files f
     WHERE a.file_id = f.id AND f.source_kind = 'drive';
   -- then GC orphan files (run-once cleanup):
   DELETE FROM rag.files
     WHERE source_kind = 'drive'
       AND NOT EXISTS (SELECT 1 FROM rag.user_file_access a WHERE a.file_id = id);
   ```
   (Note: this leaves the corresponding RAGFlow documents intact.
   Either delete them in the RAGFlow UI or wait for `/forget` to run.)

`RAG_SOURCE=both` is **not supported in v0.6.0** — the worker
explicitly rejects it. Reserved for a future release once cross-source
dedup semantics are pinned down.

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
