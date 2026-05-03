CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS chat;
CREATE SCHEMA IF NOT EXISTS pi;

-- chat.users is owned by chat-api, but we recreate the IF-NOT-EXISTS shape here
-- so the controller can run against a fresh database without depending on
-- chat-api having migrated first. Both services share the same row identity.
CREATE TABLE IF NOT EXISTS chat.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  picture TEXT,
  cf_access_sub TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (user, provider). For a given user, this row is the source of
-- truth for "does a harness container already exist". The actual container
-- (Sprite, Proxmox CT, etc.) lives wherever `provider` says.
CREATE TABLE IF NOT EXISTS pi.containers (
  user_id UUID NOT NULL REFERENCES chat.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  container_name TEXT NOT NULL,
  http_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, provider)
);
CREATE INDEX IF NOT EXISTS pi_containers_last_seen_idx ON pi.containers(last_seen_at);

-- Lightweight session audit. Not load-bearing; nice-to-have for analytics.
CREATE TABLE IF NOT EXISTS pi.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES chat.users(id) ON DELETE CASCADE,
  container_name TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS pi_sessions_user_idx ON pi.sessions(user_id, started_at DESC);
