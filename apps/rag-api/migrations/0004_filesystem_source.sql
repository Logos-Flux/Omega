-- Filesystem source for rag-ingest.
--
-- Adds a `source_kind` / `source_id` pair to rag.files so the same
-- table can hold rows from multiple sources (drive, filesystem) without
-- one having to fake the other's id format. Existing drive rows are
-- backfilled (`source_id = gdrive_file_id`); the old (tenant_id,
-- gdrive_file_id) constraint stays in place but is relaxed to allow
-- NULL so filesystem rows don't have to invent a fake id.
--
-- Uniqueness is enforced by the new (tenant_id, source_kind, source_id)
-- index. Drive rows still satisfy the old unique constraint trivially
-- because their source_id mirrors gdrive_file_id; filesystem rows have
-- gdrive_file_id IS NULL, which is treated as distinct in PG so multiple
-- filesystem rows in the same tenant don't collide on it.

ALTER TABLE rag.files
  ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'drive'
    CHECK (source_kind IN ('drive', 'filesystem')),
  ADD COLUMN IF NOT EXISTS source_id TEXT;

UPDATE rag.files SET source_id = gdrive_file_id WHERE source_id IS NULL;

ALTER TABLE rag.files ALTER COLUMN source_id SET NOT NULL;
ALTER TABLE rag.files ALTER COLUMN gdrive_file_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS files_tenant_source_idx
  ON rag.files (tenant_id, source_kind, source_id);

-- Per-user filesystem readiness, analogous to gdrive_my_ai_status.
-- Under the v0.6.0 flat layout this just mirrors tenant-level state
-- (does RAG_FILES_DIR exist + is readable). Forward-compatible with
-- the v0.7.x per-user-subdir layout, where it'll record whether the
-- user's own subdir has been provisioned.
ALTER TABLE rag.users
  ADD COLUMN IF NOT EXISTS filesystem_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (filesystem_status IN ('unknown', 'present', 'missing'));
