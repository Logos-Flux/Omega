CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS chat;

-- One row per CF Access identity. We mint a stable internal UUID on first
-- sight; downstream tables foreign-key to this UUID rather than the email
-- (so an email change in the IdP doesn't orphan rows).
CREATE TABLE IF NOT EXISTS chat.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  picture TEXT,
  cf_access_sub TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat.threads (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES chat.users(id) ON DELETE CASCADE,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_threads_user_idx ON chat.threads(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat.messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat.threads(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES chat.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_messages_thread_idx ON chat.messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS chat_messages_user_idx ON chat.messages(user_id);
