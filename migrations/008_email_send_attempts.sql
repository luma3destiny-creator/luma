-- Run on Preview before deploying the protected email endpoint.
-- No recipients, tokens or report contents are stored here.
CREATE TABLE IF NOT EXISTS email_send_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_attempt_created ON email_send_attempts(created_at);
CREATE INDEX IF NOT EXISTS idx_email_attempt_payment ON email_send_attempts(payment_id, created_at);
