-- Luma payments database schema
-- Run: npx wrangler d1 execute luma-db --file=schema.sql --remote

CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL,
  name        TEXT,
  birthdate   TEXT,   -- ISO format YYYY-MM-DD
  birthplace  TEXT,
  charge_id   TEXT UNIQUE,
  amount      INTEGER DEFAULT 5900,
  status      TEXT DEFAULT 'pending',
  token       TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  paid_at     DATETIME,
  expires_at  DATETIME
);

-- Migration for existing DB:
-- ALTER TABLE payments ADD COLUMN expires_at DATETIME;
-- ALTER TABLE payments ADD COLUMN name TEXT;
-- ALTER TABLE payments ADD COLUMN birthdate TEXT;
-- ALTER TABLE payments ADD COLUMN birthplace TEXT;

CREATE INDEX IF NOT EXISTS idx_payments_phone  ON payments(phone);
CREATE INDEX IF NOT EXISTS idx_payments_token  ON payments(token);
CREATE INDEX IF NOT EXISTS idx_payments_charge ON payments(charge_id);
