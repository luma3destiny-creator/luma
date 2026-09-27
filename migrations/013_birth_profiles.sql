-- Birth profile, one row per member account. Additive only; apply after 011_membership_core.sql.
-- Deliberately separate from `payments` (schema.sql forbids storing birthdate there) -- this
-- table is the ONLY place birth data lives, keyed to users.id, never to a payment or phone.
-- Validate on Preview (luma-db-preview) before Production. IF NOT EXISTS does not repair schema drift.

CREATE TABLE IF NOT EXISTS birth_profiles (
  user_id      TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  birth_year   INTEGER NOT NULL CHECK(typeof(birth_year) = 'integer' AND birth_year BETWEEN 1900 AND 2100),
  birth_month  INTEGER NOT NULL CHECK(typeof(birth_month) = 'integer' AND birth_month BETWEEN 1 AND 12),
  birth_day    INTEGER NOT NULL CHECK(typeof(birth_day) = 'integer' AND birth_day BETWEEN 1 AND 31),
  birth_hour   INTEGER NOT NULL CHECK(typeof(birth_hour) = 'integer' AND birth_hour BETWEEN 0 AND 23),
  birth_minute INTEGER NOT NULL CHECK(typeof(birth_minute) = 'integer' AND birth_minute BETWEEN 0 AND 59),
  -- Free-text place name, same convention as payments.birthplace (no enum/CHECK).
  birth_place  TEXT NOT NULL CHECK(length(birth_place) BETWEEN 1 AND 200),
  gender       TEXT NOT NULL CHECK(gender IN ('m', 'f')),
  created_at   INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at   INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at)
);
