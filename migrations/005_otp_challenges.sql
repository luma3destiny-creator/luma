-- migrations/005_otp_challenges.sql
-- Additive only. Backing store for OTP recovery (/api/request-otp, /api/verify-otp).
-- Does not touch `payments`. Does not delete anything. Safe to re-run.
--
-- Nothing here is reversible into a phone number or a code: both are stored
-- only as salted hashes (the salt/pepper lives in env.OTP_PEPPER, not in the DB),
-- so this table is not a customer list and not a set of working codes.
--
-- Run on Preview FIRST:
--   npx wrangler d1 execute luma-db-preview --remote --file=migrations/005_otp_challenges.sql

CREATE TABLE IF NOT EXISTS otp_challenges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id    TEXT UNIQUE,        -- opaque id handed to the browser; not the row id
  phone_hash   TEXT NOT NULL,      -- SHA-256(pepper:phone:E164) — never the number
  ip_hash      TEXT,               -- SHA-256(pepper:ip:…) — for per-IP throttling
  code_hash    TEXT NOT NULL,      -- SHA-256(pepper:phone:code) — never the code
  created_at   DATETIME NOT NULL,
  expires_at   DATETIME NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  consumed_at  DATETIME,
  -- 1 once this challenge has reserved a unit of the daily SMS budget. A row is
  -- written for EVERY request — including numbers that are not customers, so the
  -- throttles cannot be used to tell the two apart — but only rows that were
  -- actually going to be sent set this, and only these count towards the cap.
  sms_reserved INTEGER NOT NULL DEFAULT 0,
  -- The token this challenge will hand over, decided in the same statement that
  -- consumes the code. It exists so that a worker dying between "code accepted"
  -- and "token written to payments" cannot burn a customer's code for nothing:
  -- presenting the same code again finishes the job and returns the SAME token.
  -- Cleared as soon as it reaches `payments`.
  issued_token  TEXT,
  token_applied INTEGER NOT NULL DEFAULT 0,
  -- Send outcome, for the operational counters (see the cost report).
  -- Holds a provider name and a coarse status only: never the code, never
  -- the number, never a provider credential.
  provider     TEXT,
  send_status  TEXT,              -- 'sent' (provider accepted) | 'failed' | 'unknown'
  send_error   TEXT               -- coarse reason, e.g. 'no_sender_id'
);

CREATE INDEX IF NOT EXISTS idx_otp_phone_created ON otp_challenges(phone_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_otp_ip_created    ON otp_challenges(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_otp_created       ON otp_challenges(created_at);
CREATE INDEX IF NOT EXISTS idx_otp_public        ON otp_challenges(public_id);
CREATE INDEX IF NOT EXISTS idx_otp_reserved      ON otp_challenges(sms_reserved, created_at);
