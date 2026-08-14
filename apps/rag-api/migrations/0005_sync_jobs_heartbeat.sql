-- BUG-09 / QUAL-15 — give the reaper a heartbeat lease and record partial
-- failures.
--
-- heartbeat_at: the crawler bumps this every N files. The reaper treats a
-- 'running' job as a zombie only when COALESCE(heartbeat_at, started_at) is
-- older than the timeout, so a genuinely-long live crawl that keeps
-- heartbeating is never falsely reaped (which used to spawn concurrent
-- duplicate crawls interleaving RAGFlow delete/upload for the same files).
--
-- files_failed: a crawl can finish 'completed' while some files failed to
-- ingest; record the count so partial failures are queryable instead of
-- being visible only in logs.

ALTER TABLE rag.sync_jobs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
ALTER TABLE rag.sync_jobs ADD COLUMN IF NOT EXISTS files_failed INT;
