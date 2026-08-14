-- DB-15 — enum-like CHECK on rag.sync_jobs.status. NOT VALID so it enforces on
-- new writes without validating existing rows (safe on a live table).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rag_sync_jobs_status_check'
  ) THEN
    ALTER TABLE rag.sync_jobs
      ADD CONSTRAINT rag_sync_jobs_status_check
      CHECK (status IN ('queued', 'running', 'completed', 'failed', 'pending')) NOT VALID;
  END IF;
END $$;
