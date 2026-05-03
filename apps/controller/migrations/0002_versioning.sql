-- Sprite versioning + release channels.
--
-- This migration is purely additive. Defaults are chosen so existing rows
-- keep working: every current chat.users row lands on 'launch' and every
-- existing pi.containers row gets base_image_version=NULL (= "legacy
-- shared sprite, untracked"). The provisioning code only consults these
-- columns when applying golden snapshots via the SpritesProvider path.

-- 1. Per-user release channel. New users default to 'launch' (the
--    safest cohort); admins promote individuals to 'beta' / 'alpha'.
ALTER TABLE chat.users
  ADD COLUMN IF NOT EXISTS release_channel TEXT NOT NULL DEFAULT 'launch';

DO $$ BEGIN
  ALTER TABLE chat.users
    ADD CONSTRAINT chat_users_release_channel_check
    CHECK (release_channel IN ('alpha','beta','launch'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Container versioning columns. NULL base_image_version means "this
--    container predates the supervision system" — the orchestrator
--    treats it as legacy and skips update logic.
ALTER TABLE pi.containers
  ADD COLUMN IF NOT EXISTS base_image_version TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS last_updated_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE pi.containers
    ADD CONSTRAINT pi_containers_status_check
    CHECK (status IN ('active','pending_update','updating','retired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. Source of truth for golden manifests. One row per immutable
--    version; channels are an array so a manifest can be promoted
--    alpha -> beta -> launch by appending without ever rewriting
--    history. retired_at blocks new provisions of a known-bad version.
CREATE TABLE IF NOT EXISTS pi.golden_images (
  version TEXT PRIMARY KEY,
  manifest_uri TEXT NOT NULL,
  manifest_sha TEXT NOT NULL,
  notes TEXT,
  built_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_to TEXT[] NOT NULL DEFAULT ARRAY['alpha']::TEXT[],
  promoted_at JSONB NOT NULL DEFAULT '{}'::JSONB,
  retired_at TIMESTAMPTZ
);

-- Lookup pattern is "latest non-retired version released to channel X".
-- A GIN on released_to plus an index on retired_at handles it.
CREATE INDEX IF NOT EXISTS pi_golden_images_released_to_idx
  ON pi.golden_images USING GIN (released_to);

CREATE INDEX IF NOT EXISTS pi_golden_images_retired_at_idx
  ON pi.golden_images (retired_at)
  WHERE retired_at IS NULL;

-- 4. Audit log of every update attempt. Useful for debugging stuck
--    fleets, surfacing "your sprite was updated to 1.5.1 at 14:02"
--    in the UI, and feeding the admin /api/admin/fleet endpoint.
CREATE TABLE IF NOT EXISTS pi.update_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES chat.users(id) ON DELETE CASCADE,
  from_version TEXT,
  to_version TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT
);

DO $$ BEGIN
  ALTER TABLE pi.update_audit
    ADD CONSTRAINT pi_update_audit_status_check
    CHECK (status IN ('running','completed','failed','rolled_back'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS pi_update_audit_user_idx
  ON pi.update_audit (user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS pi_update_audit_running_idx
  ON pi.update_audit (started_at DESC)
  WHERE status = 'running';
