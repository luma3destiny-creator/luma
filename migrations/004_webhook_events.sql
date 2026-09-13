-- migrations/004_webhook_events.sql
-- Additive only. Creates the table /api/stripe-webhook uses to recognise a
-- replayed Stripe event. Does not touch `payments` and does not delete anything.
--
-- Stripe does not guarantee exactly-once delivery: the same event id can be
-- delivered more than once, and it retries for up to three days. The PRIMARY
-- KEY is what makes a replay a no-op — INSERT OR IGNORE reports 0 rows changed
-- the second time an event id arrives.
--
-- Run on Preview FIRST (luma-db-preview), then Production (luma-db) only after
-- the Preview webhook has been exercised end to end.
--
--   npx wrangler d1 execute luma-db-preview --remote --file=migrations/004_webhook_events.sql
--
-- Safe to re-run: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id    TEXT PRIMARY KEY,   -- Stripe's evt_… id; the deduplication key
  event_type  TEXT,
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events(received_at);
