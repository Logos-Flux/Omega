-- DB-25 — provisioning lifecycle on pi.containers.
--
-- autoProvisionAndBootstrap previously held a pooled connection + an open
-- transaction across the slow sprite-create + bootstrap network calls (5-30s on
-- a cold sprite), so a handful of concurrent cold sign-ins could exhaust the
-- pool. It now reserves the row in a SHORT committed transaction
-- (status='provisioning'), does all network work with NO db client held, then
-- finalizes the row to 'active'.
--
-- provisioning_started_at lets the next /start recover a STALE abandoned
-- provisioning row (the process died mid-provision) by taking it over, instead
-- of wedging the user on a permanent "concurrent provisioning" 409.
--
-- Purely additive; existing rows keep status='active'.

ALTER TABLE pi.containers
  ADD COLUMN IF NOT EXISTS provisioning_started_at TIMESTAMPTZ;

-- Extend the status vocabulary with 'provisioning'. The 0002 constraint only
-- allowed the golden-update-supervision states; drop + re-add with the new
-- value so a freshly reserved (not-yet-finalized) row is representable.
DO $$ BEGIN
  ALTER TABLE pi.containers DROP CONSTRAINT IF EXISTS pi_containers_status_check;
  ALTER TABLE pi.containers
    ADD CONSTRAINT pi_containers_status_check
    CHECK (status IN ('provisioning','active','pending_update','updating','retired'));
END $$;

-- Fast lookup of stale provisioning rows for takeover.
CREATE INDEX IF NOT EXISTS pi_containers_provisioning_idx
  ON pi.containers (provisioning_started_at)
  WHERE status = 'provisioning';
