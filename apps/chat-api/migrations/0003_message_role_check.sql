-- DB-15 — enum-like CHECK on chat.messages.role (house style, cf.
-- pi_containers_status_check). Added NOT VALID so it enforces on new writes
-- without scanning/validating existing rows (safe on a live table); a later
-- VALIDATE CONSTRAINT can confirm the backfill when convenient.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_role_check'
  ) THEN
    ALTER TABLE chat.messages
      ADD CONSTRAINT chat_messages_role_check
      CHECK (role IN ('user', 'assistant', 'system', 'tool')) NOT VALID;
  END IF;
END $$;
