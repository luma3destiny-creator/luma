CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, name TEXT,
  age_at_purchase INTEGER, birthplace TEXT, charge_id TEXT UNIQUE,
  amount INTEGER DEFAULT 5900, status TEXT DEFAULT 'pending', token TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, paid_at DATETIME, expires_at DATETIME);
