-- migrations/010_preview_test_switch.sql
--
-- PREVIEW ONLY. NEVER RUN THIS ON luma-db.
--
--   npx.cmd wrangler d1 execute luma-db-preview --remote --yes --file=migrations/010_preview_test_switch.sql
--
-- Why this exists. The AI test mode (functions/lib/ai-provider.mjs) must not be
-- able to run in Production even if someone copies AI_MOCK_ENV and
-- AI_MOCK_SECRET into Production's variables by mistake. A variable is only a
-- switch the owner sets; it is not evidence of where the code is running.
-- Cloudflare's CF_PAGES_* values are documented for the BUILD, and the docs do
-- not say they reach Pages Functions at runtime, so they are not relied on.
--
-- What IS known to reach Pages Functions at runtime is the D1 binding, and
-- Cloudflare binds a different database per environment: Preview is bound to
-- luma-db-preview, Production to luma-db. This table exists only in the
-- preview database, so the test mode's first check -- "does the database I am
-- bound to say it is the preview database?" -- fails in Production.
--
-- It is also a switch that works on EVERY deployment at once, including old
-- preview deployments that still carry old variables: test mode needs
-- ai_mock_until to be in the future, it is off by default, it switches itself
-- off when that time passes, and setting it back to NULL turns it off
-- immediately everywhere.
--
-- Additive. Deletes nothing. Does not touch payments or ai_quota_events.
-- Safe to re-run: the row is created OFF and an existing row is left alone.

CREATE TABLE IF NOT EXISTS preview_test_switch (
  id            INTEGER PRIMARY KEY CHECK (id = 1),   -- exactly one row
  environment   TEXT NOT NULL,                        -- 'preview'
  ai_mock_until DATETIME                              -- NULL = test mode OFF
);

INSERT OR IGNORE INTO preview_test_switch (id, environment, ai_mock_until)
VALUES (1, 'preview', NULL);

-- Turn test mode ON for two hours (run when you start testing):
--   UPDATE preview_test_switch SET ai_mock_until = datetime('now', '+2 hours') WHERE id = 1;
-- Turn it OFF now, on every deployment (run when you finish):
--   UPDATE preview_test_switch SET ai_mock_until = NULL WHERE id = 1;
-- Check it:
--   SELECT environment, ai_mock_until, datetime('now') AS now FROM preview_test_switch;
