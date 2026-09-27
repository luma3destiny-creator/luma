-- migrations/016_otp_challenges_purpose.sql
-- Additive only. Scopes every otp_challenges row to the ONE thing it may be
-- used for, so a code issued for phone-recovery can never be replayed to link
-- an old purchase to a member account, and vice versa.
--
-- purpose      'recovery' (default -- every existing and future
--              /api/request-otp row) or 'link_purchase' (every
--              /api/member/link-request-otp row).
-- user_id      set ONLY for purpose='link_purchase': the signed-in caller who
--              asked for the code, bound at REQUEST time. confirm-time re-checks
--              this against the caller's own session -- a link challenge can
--              only ever be confirmed by the same account that requested it.
-- payment_id   set ONLY for purpose='link_purchase': the specific still-unlinked
--              order picked at REQUEST time. confirm-time links THIS row, never
--              a fresh "latest unlinked" lookup -- so a second order arriving
--              for the same phone between request and confirm cannot be
--              silently substituted, and two concurrent requests for the same
--              phone cannot both land on the same order (the write in
--              functions/lib/otp.mjs:applyOwnerToOrder is guarded by
--              owner_user_id IS NULL, so only the first one to actually write
--              wins; see that function's own comment for why this is safe).
--
-- Validate on Preview (luma-db-preview) before Production; check
-- PRAGMA table_info(otp_challenges) for a pre-existing column with a
-- different definition before re-running this on any database that might
-- already have one (IF NOT EXISTS / ADD COLUMN does not repair schema drift).

ALTER TABLE otp_challenges ADD COLUMN purpose TEXT NOT NULL DEFAULT 'recovery'
  CHECK(purpose IN ('recovery', 'link_purchase'));
ALTER TABLE otp_challenges ADD COLUMN user_id TEXT
  CHECK(user_id IS NULL OR length(user_id) BETWEEN 16 AND 128);
ALTER TABLE otp_challenges ADD COLUMN payment_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_otp_purpose ON otp_challenges(purpose, created_at);
