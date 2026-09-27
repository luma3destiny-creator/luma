-- Adds first/last name and a "birth time unknown" flag to the existing birth_profiles table.
-- Additive only -- never edit 013_birth_profiles.sql, which has already run on Preview.
-- Existing rows (saved before this feature existed) get NULL name and time_unknown=0,
-- and continue to read back without error.
-- Validate on Preview (luma-db-preview) before Production.

ALTER TABLE birth_profiles ADD COLUMN first_name TEXT
  CHECK(first_name IS NULL OR length(first_name) BETWEEN 1 AND 100);
ALTER TABLE birth_profiles ADD COLUMN last_name TEXT
  CHECK(last_name IS NULL OR length(last_name) BETWEEN 1 AND 100);
-- 1 = the customer does not remember their exact birth time; birth_hour/birth_minute are
-- then forced to 12:00 as an estimate by the server, never trusted from the browser. Kept
-- separate from the time columns themselves so a real-noon birth time stays distinguishable
-- from an estimated one.
ALTER TABLE birth_profiles ADD COLUMN time_unknown INTEGER NOT NULL DEFAULT 0
  CHECK(time_unknown IN (0, 1));
