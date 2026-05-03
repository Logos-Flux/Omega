-- Pivot from service-account folder polling to per-user OAuth crawl
-- with file-level ACLs. The chat product (RAG-HANDOFF.md) drives this:
-- one OAuth client across chat + RAG, per-user crawl with that user's
-- token, dedup files across users, query-time ACL filter via RAGFlow's
-- document_ids body parameter.

-- Drop the superseded folder-polling tables. They have no production
-- data; the original ingest worker never ran anything.
DROP TABLE IF EXISTS rag.gdrive_folders;
DROP TABLE IF EXISTS rag.ingest_state;

-- A user known to the RAG side. chat_user_id is the opaque value chat
-- sends in request bodies; logically chat.users.id from Fly Postgres
-- but no enforced FK because the DBs are separate.
CREATE TABLE IF NOT EXISTS rag.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES rag.tenants(id) ON DELETE CASCADE,
  chat_user_id UUID NOT NULL,
  drive_oauth_status TEXT NOT NULL DEFAULT 'pending',
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, chat_user_id)
);
CREATE INDEX IF NOT EXISTS rag_users_chat_idx ON rag.users(chat_user_id);

-- One row per file the tenant has ever seen. Dedup across users by
-- (tenant_id, gdrive_file_id). content_hash drives "do we need to
-- re-embed". ragflow_doc_id is the upstream RAGFlow document id we use
-- in the document_ids retrieval filter.
CREATE TABLE IF NOT EXISTS rag.files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES rag.tenants(id) ON DELETE CASCADE,
  dataset_id UUID NOT NULL REFERENCES rag.datasets(id) ON DELETE CASCADE,
  gdrive_file_id TEXT NOT NULL,
  content_hash TEXT,
  mime_type TEXT,
  name TEXT,
  ragflow_doc_id TEXT,
  size_bytes BIGINT,
  last_indexed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, gdrive_file_id)
);
CREATE INDEX IF NOT EXISTS rag_files_dataset_idx ON rag.files(dataset_id);
CREATE INDEX IF NOT EXISTS rag_files_ragflow_idx ON rag.files(ragflow_doc_id);

-- The ACL. One row per (user, file) pair the user can see. Refreshed
-- on every per-user crawl. Files that drop out of a user's listing
-- (lost share) get their row deleted next crawl.
CREATE TABLE IF NOT EXISTS rag.user_file_access (
  user_id UUID NOT NULL REFERENCES rag.users(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES rag.files(id) ON DELETE CASCADE,
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, file_id)
);
CREATE INDEX IF NOT EXISTS rag_user_file_access_file_idx ON rag.user_file_access(file_id);

-- Backs /api/v1/users/sync and /api/v1/users/:id/status. The ingest
-- worker pulls the next 'queued' job with FOR UPDATE SKIP LOCKED.
CREATE TABLE IF NOT EXISTS rag.sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES rag.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error TEXT,
  files_seen INT,
  files_changed INT
);
CREATE INDEX IF NOT EXISTS rag_sync_jobs_user_idx ON rag.sync_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rag_sync_jobs_status_idx ON rag.sync_jobs(status, created_at);

-- Single tenant for v1. Multi-tenant becomes a row-add when external
-- customers exist; no schema change needed.
INSERT INTO rag.tenants (slug, name)
  VALUES ('omega', 'Omega')
  ON CONFLICT (slug) DO NOTHING;
