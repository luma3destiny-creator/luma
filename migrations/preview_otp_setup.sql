-- migrations/preview_otp_setup.sql
--
-- ONE file to prepare luma-db-preview for the OTP walkthrough. It is 004 + 005
-- + 006 concatenated, in that order.
--
--   npx wrangler d1 execute luma-db-preview --remote --file=migrations/preview_otp_setup.sql
--
-- PREVIEW ONLY — do not run this against luma-db. Production gets 004 and 005
-- separately, and never 006 (the test outbox holds plaintext codes by design).
--
-- Everything here is CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- No DROP, no DELETE, no ALTER, no UPDATE: it cannot remove or change a single
-- existing row, and running it twice does nothing the second time.
-- It does not touch `payments`.

-- ─── 004: Stripe webhook replay guard ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id    TEXT PRIMARY KEY,
  event_type  TEXT,
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events(received_at);

-- ─── 005: OTP challenges ────────────────────────────────────────────────────
-- Phone numbers and codes are stored only as salted hashes; the pepper lives in
-- env.OTP_PEPPER, not in the database. This table is not a customer list and
-- not a set of working codes.
CREATE TABLE IF NOT EXISTS otp_challenges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id    TEXT UNIQUE,
  phone_hash   TEXT NOT NULL,
  ip_hash      TEXT,
  code_hash    TEXT NOT NULL,
  created_at   DATETIME NOT NULL,
  expires_at   DATETIME NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  consumed_at  DATETIME,
  sms_reserved INTEGER NOT NULL DEFAULT 0,
  issued_token  TEXT,
  token_applied INTEGER NOT NULL DEFAULT 0,
  provider     TEXT,
  send_status  TEXT,
  send_error   TEXT
);
CREATE INDEX IF NOT EXISTS idx_otp_phone_created ON otp_challenges(phone_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_otp_ip_created    ON otp_challenges(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_otp_created       ON otp_challenges(created_at);
CREATE INDEX IF NOT EXISTS idx_otp_public        ON otp_challenges(public_id);
CREATE INDEX IF NOT EXISTS idx_otp_reserved      ON otp_challenges(sms_reserved, created_at);

-- ─── 006: PREVIEW-ONLY test outbox ──────────────────────────────────────────
-- Holds the code during a walkthrough, because the code must not come back from
-- the API and must not go into the log. Written to only when SMS_PROVIDER=mock
-- AND OTP_TEST_OUTBOX=true AND the recipient is listed in OTP_TEST_PHONES.
CREATE TABLE IF NOT EXISTS otp_test_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT,
  code       TEXT,
  body       TEXT,
  created_at DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_test_outbox_created ON otp_test_outbox(created_at);
