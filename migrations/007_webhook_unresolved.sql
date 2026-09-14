-- migrations/007_webhook_unresolved.sql
-- Additive only. Deletes nothing. Safe to re-run. Does not touch `payments`.
--
--   npx wrangler d1 execute luma-db-preview --remote --file=migrations/007_webhook_unresolved.sql
--
-- Why this table exists.
--
-- `webhook_events` means "this event is FINISHED". Some events are not finished
-- and cannot be: the order row is not there yet, or the data needs a person.
-- Writing those into webhook_events would close them out forever on a guess --
-- an earlier version did exactly that after an hour, on the reasoning that the
-- order was never coming, which is not something the code can know.
--
-- So they go here instead, with the raw payload kept, and they are NEVER marked
-- finished. That makes them countable, inspectable, and re-processable: the
-- stored payload can be replayed through the endpoint (or resent from the
-- Stripe Dashboard) and, because it was never recorded as handled, it runs for
-- real rather than being answered "duplicate ignored".
--
-- Operator queries:
--   SELECT event_id, charge_id, reason, attempts, first_seen_at, last_seen_at
--     FROM webhook_unresolved WHERE resolved_at IS NULL ORDER BY first_seen_at;
--   SELECT COUNT(*) FROM webhook_unresolved WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS webhook_unresolved (
  event_id      TEXT PRIMARY KEY,
  event_type    TEXT,
  charge_id     TEXT,
  reason        TEXT,        -- 'no_order' | 'entitlement_incomplete' | …
  payload       TEXT,        -- the raw event body, so it can be replayed
  attempts      INTEGER NOT NULL DEFAULT 1,
  first_seen_at DATETIME NOT NULL,
  last_seen_at  DATETIME NOT NULL,
  resolved_at   DATETIME     -- set when a later delivery completed it
);

CREATE INDEX IF NOT EXISTS idx_webhook_unresolved_open ON webhook_unresolved(resolved_at, first_seen_at);
