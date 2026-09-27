-- Membership foundation only. No payment changes and no automatic account claims.
-- Validate on Preview before Production. IF NOT EXISTS does not repair schema drift.
-- OAuth callbacks, ownership checks and authenticated sessions are not enabled by this migration.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 16 AND 128),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Provider subject is the verified provider user ID, never an email or display name.
-- Account linking requires fresh proof of both identities in application code.
CREATE TABLE IF NOT EXISTS auth_identities (
  provider TEXT NOT NULL CHECK(provider IN ('line', 'google')),
  provider_subject TEXT NOT NULL CHECK(length(provider_subject) BETWEEN 1 AND 255),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(provider, provider_subject),
  UNIQUE(user_id, provider)
);

-- Only SHA-256 digests are stored. Raw session tokens belong in secure HttpOnly cookies.
-- Times below are Unix seconds. Authentication must check expiry/revocation/user status.
CREATE TABLE IF NOT EXISTS member_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL
    CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at > created_at),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR
    (typeof(revoked_at) = 'integer' AND revoked_at >= created_at))
);
CREATE INDEX IF NOT EXISTS idx_member_sessions_user ON member_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_member_sessions_expiry ON member_sessions(expires_at);
