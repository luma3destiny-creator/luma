-- Apply after 011 on Preview first. No OAuth codes, access tokens or secrets stored.
-- The PKCE verifier is an ephemeral HttpOnly browser cookie, bound by browser_hash.
CREATE TABLE IF NOT EXISTS oauth_transactions (
  state_hash TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('line', 'google')),
  browser_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_oauth_transactions_ip ON oauth_transactions(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_oauth_transactions_expiry ON oauth_transactions(expires_at);
