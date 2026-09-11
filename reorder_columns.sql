-- One-time migration: rebuild `payments` with name/birthdate/birthplace
-- placed right after phone (SQLite can't reorder columns with ALTER TABLE).
-- Run: npx wrangler d1 execute luma-db --remote --file=reorder_columns.sql

CREATE TABLE payments_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL,
  name        TEXT,
  birthdate   TEXT,
  birthplace  TEXT,
  charge_id   TEXT UNIQUE,
  amount      INTEGER DEFAULT 5900,
  status      TEXT DEFAULT 'pending',
  token       TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  paid_at     DATETIME,
  expires_at  DATETIME
);

INSERT INTO payments_new (id, phone, name, birthdate, birthplace, charge_id, amount, status, token, created_at, paid_at, expires_at)
SELECT id, phone, name, birthdate, birthplace, charge_id, amount, status, token, created_at, paid_at, expires_at
FROM payments;

DROP TABLE payments;

ALTER TABLE payments_new RENAME TO payments;

CREATE INDEX IF NOT EXISTS idx_payments_phone  ON payments(phone);
CREATE INDEX IF NOT EXISTS idx_payments_token  ON payments(token);
CREATE INDEX IF NOT EXISTS idx_payments_charge ON payments(charge_id);
