-- migrations/006_preview_test_outbox.sql
--
-- PREVIEW ONLY. DO NOT RUN THIS ON luma-db.
--
-- Somewhere has to hold the code during a Preview walkthrough, because the code
-- must NOT come back from the API and must NOT go into the log: Preview URLs are
-- public and logs are not a secret store. This table is the alternative — only
-- the account owner can read it (wrangler d1 / the D1 console).
--
-- It is written to only when ALL THREE of these are true, and each is off by
-- default:
--     SMS_PROVIDER    = mock
--     OTP_TEST_OUTBOX = true
--     the recipient is listed in OTP_TEST_PHONES
-- Any real provider skips the path entirely (see functions/lib/sms.mjs).
--
-- Additive only, deletes nothing, safe to re-run:
--   npx wrangler d1 execute luma-db-preview --remote --file=migrations/006_preview_test_outbox.sql
--
-- When the walkthrough is done, unset OTP_TEST_OUTBOX and clear the table:
--   DELETE FROM otp_test_outbox;

CREATE TABLE IF NOT EXISTS otp_test_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT,       -- an internal test number only; never a customer's
  code       TEXT,       -- plaintext, deliberately: this is the tester's copy
  body       TEXT,
  created_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_otp_test_outbox_created ON otp_test_outbox(created_at);
