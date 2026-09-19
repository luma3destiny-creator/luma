-- migrations/008_ai_quota.sql
-- Additive only. Deletes nothing. Does not touch `payments`. Safe to re-run.
--
--   npx wrangler d1 execute luma-db-preview --remote --file=migrations/008_ai_quota.sql
--
-- One row per AI call that was ALLOWED to reach the provider. Requests turned
-- away (over the limit, invalid input, no entitlement, no API key) leave no row.
-- A row is never removed to "give a call back": a call that failed or timed
-- out may still have been billed. See functions/lib/ai-quota.mjs.
--
-- Deliberately stores nothing personal: no IP address (only an HMAC keyed with
-- AI_QUOTA_IP_SECRET), no name, birth date, image, report text or token.
--
-- CLEANING UP OLD ROWS without changing any limit:
--   A limit only ever counts rows newer than its own window. Deleting rows
--   older than the LONGEST window in use therefore cannot change any count.
--   With the default 1-day windows, 2 days leaves a margin:
--     DELETE FROM ai_quota_events WHERE created_at < datetime('now', '-2 days');
--   If a window is ever raised, raise this horizon to at least that window
--   first, or the limit will under-count for that period.

CREATE TABLE IF NOT EXISTS ai_quota_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket     TEXT NOT NULL,        -- 'free' | 'paid' — separate budgets
  subject    TEXT NOT NULL,        -- 'ip:<hmac>' or 'pay:<payments.id>' — never a raw IP or a token
  route      TEXT NOT NULL,        -- which endpoint, for the operator's counts
  created_at DATETIME NOT NULL,
  outcome    TEXT                  -- 'reserved' | 'ok' | 'provider_error' | 'unknown' (informational)
);

-- Both counts in the reservation statement are range scans on these.
CREATE INDEX IF NOT EXISTS idx_ai_quota_subject ON ai_quota_events(bucket, subject, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_quota_bucket  ON ai_quota_events(bucket, created_at);
