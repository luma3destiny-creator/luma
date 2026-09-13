-- Luma payments database schema
-- Run: npx wrangler d1 execute luma-db --file=schema.sql --remote
--
-- We do NOT store customer birthdates. `age_at_purchase` is the customer's
-- full age in years AS OF created_at for that specific row (the moment the
-- payment record was created) — not their current age, and it is computed
-- once at write time and never re-derivable back into a birthdate. See
-- functions/lib/age.mjs for the exact computation rules (Asia/Bangkok
-- calendar day, leap-year/Feb-29 handling, invalid/future-date rejection).
-- If age could not be computed for a row, age_at_purchase is NULL — never 0.

CREATE TABLE IF NOT EXISTS payments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phone            TEXT NOT NULL,
  name             TEXT,
  age_at_purchase  INTEGER, -- full years old as of THIS row's created_at; NULL if unknown/invalid
  birthplace       TEXT,
  charge_id        TEXT UNIQUE,
  amount           INTEGER DEFAULT 5900,
  status           TEXT DEFAULT 'pending',
  token            TEXT,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  paid_at          DATETIME,
  expires_at       DATETIME
);

-- Migration history for existing DBs (chronological; keep for reference):
-- ALTER TABLE payments ADD COLUMN expires_at DATETIME;
-- ALTER TABLE payments ADD COLUMN name TEXT;
-- ALTER TABLE payments ADD COLUMN birthdate TEXT;                 -- superseded, see below
-- ALTER TABLE payments ADD COLUMN birthplace TEXT;
--
-- Birthdate retirement (do NOT re-run — see migrations/ for the actual
-- staged rollout, which requires explicit approval before phase 3):
--   phase 1: migrations/001_add_age_at_purchase.sql   (adds age_at_purchase, additive only)
--   phase 2: migrations/002_backfill_age_at_purchase.sql (generated per-row UPDATEs from birthdate)
--   phase 3: migrations/003_drop_birthdate.sql         (rebuilds the table without birthdate — destructive, irreversible)

CREATE INDEX IF NOT EXISTS idx_payments_phone  ON payments(phone);
CREATE INDEX IF NOT EXISTS idx_payments_token  ON payments(token);
CREATE INDEX IF NOT EXISTS idx_payments_charge ON payments(charge_id);
