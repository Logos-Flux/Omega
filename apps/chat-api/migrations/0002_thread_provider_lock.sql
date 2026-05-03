-- I.D.1 — Per-thread provider lock-in.
-- Once the first turn of a thread lands, the provider+model selected at that
-- moment becomes the thread's pin. Subsequent turns inherit the locked value
-- so the Anthropic / Gemini prompt cache actually pays off; mid-thread switches
-- require an explicit override flag from the client (see src/routes/chat.ts).
--
-- NULL = unlocked (legacy threads + brand-new threads pre-first-turn). Once
-- locked, never null. We keep the columns nullable rather than backfilling
-- because legacy threads predate the locking concept and we want their next
-- turn to lock them naturally.
ALTER TABLE chat.threads ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE chat.threads ADD COLUMN IF NOT EXISTS model TEXT;
