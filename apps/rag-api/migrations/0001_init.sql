CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS rag;

-- One row per customer/tenant. Slug is the human-readable handle used in
-- env vars and admin tooling; id is what every other table references.
CREATE TABLE IF NOT EXISTS rag.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bearer tokens. We store sha256 of the raw token so a DB leak doesn't
-- hand over usable tokens. The raw value is shown once at creation time.
CREATE TABLE IF NOT EXISTS rag.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES rag.tenants(id) ON DELETE CASCADE,
  token_sha256 TEXT UNIQUE NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS rag_api_keys_tenant_idx ON rag.api_keys(tenant_id);

-- Mapping from a RAGFlow dataset (knowledge base) to one of our tenants.
-- Datasets are created by us, never directly by users; tenant_id is the
-- isolation key the wrapper enforces.
CREATE TABLE IF NOT EXISTS rag.datasets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES rag.tenants(id) ON DELETE CASCADE,
  ragflow_dataset_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS rag_datasets_tenant_idx ON rag.datasets(tenant_id);

-- Which GDrive folders feed which datasets. The ingest worker reads this
-- table to decide what to poll. Folders can be shared with the service
-- account email or accessed via domain-wide delegation as `delegate_email`.
CREATE TABLE IF NOT EXISTS rag.gdrive_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES rag.tenants(id) ON DELETE CASCADE,
  dataset_id UUID NOT NULL REFERENCES rag.datasets(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL,
  delegate_email TEXT,
  poll_interval_seconds INTEGER NOT NULL DEFAULT 900,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS rag_gdrive_folders_dataset_idx ON rag.gdrive_folders(dataset_id);

-- Per-(tenant,file) state for incremental sync. The composite PK lets the
-- ingest worker UPSERT cheaply on every poll.
CREATE TABLE IF NOT EXISTS rag.ingest_state (
  tenant_id UUID NOT NULL REFERENCES rag.tenants(id) ON DELETE CASCADE,
  dataset_id UUID NOT NULL REFERENCES rag.datasets(id) ON DELETE CASCADE,
  gdrive_file_id TEXT NOT NULL,
  ragflow_doc_id TEXT,
  last_modified_time TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  PRIMARY KEY (tenant_id, gdrive_file_id)
);
CREATE INDEX IF NOT EXISTS rag_ingest_state_status_idx ON rag.ingest_state(status);

-- Lightweight audit log. Useful for "why did query X return chunks from
-- doc Y" questions and for billing-style usage rollups.
CREATE TABLE IF NOT EXISTS rag.audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES rag.tenants(id) ON DELETE CASCADE,
  api_key_id UUID REFERENCES rag.api_keys(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS rag_audit_tenant_time_idx ON rag.audit(tenant_id, created_at DESC);
