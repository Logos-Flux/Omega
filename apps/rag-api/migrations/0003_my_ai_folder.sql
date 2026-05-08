-- Per-user `my-ai/` folder + shared `Knowledge Base/` scoping.
--
-- Replaces the static RAG_FOLDER_ALLOWLIST model with two roots:
--   1. A personal folder owned by each user (default name `my-ai`,
--      configurable via RAG_PERSONAL_FOLDER_NAME).
--   2. An optional shared folder ID (RAG_KNOWLEDGE_BASE_FOLDER_ID) that
--      every user crawls. Per-user OAuth permissions naturally filter
--      which subfolders/files each user can see inside it.
--
-- The personal folder ID is cached on the rag.users row after first
-- lookup. `gdrive_my_ai_status` records whether the lookup succeeded
-- ('present' | 'missing' | 'unknown') so the worker doesn't re-resolve
-- on every tick AND so the chat-side status UI can prompt the user to
-- create the folder if it's missing.

ALTER TABLE rag.users
  ADD COLUMN IF NOT EXISTS gdrive_my_ai_folder_id TEXT,
  ADD COLUMN IF NOT EXISTS gdrive_my_ai_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (gdrive_my_ai_status IN ('unknown', 'present', 'missing'));
