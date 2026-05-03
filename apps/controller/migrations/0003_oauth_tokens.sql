-- Phase 0.B.1 — OAuth refresh-token storage.
--
-- One row per (user, provider). The `refresh_token` column stores the
-- application-layer AES-256-GCM ciphertext (base64 of nonce || ct || tag),
-- NOT the plaintext and NOT a pgcrypto-encrypted blob — encryption happens
-- in the controller process via src/lib/crypto.ts so the DB and DB backups
-- never see plaintext refresh tokens. Key lives in Fly secret
-- OAUTH_TOKEN_ENC_KEY (rotation = re-encrypt-all migration; no key versioning).
--
-- Access tokens are minted on-demand from refresh tokens and never stored.
CREATE TABLE IF NOT EXISTS pi.oauth_tokens (
  user_id UUID NOT NULL REFERENCES chat.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_refreshed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, provider)
);

CREATE INDEX IF NOT EXISTS pi_oauth_tokens_provider_idx
  ON pi.oauth_tokens (provider);
