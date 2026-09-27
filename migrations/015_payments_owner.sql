-- Links a `payments` row to the member account that made the purchase while
-- signed in. Additive only: one nullable column plus an index.
--
-- NULL means "not linked to any member account" -- true for every purchase
-- made before member accounts existed, and for any purchase made while
-- signed out today. It is set in exactly two places, both server-side:
--   1. functions/api/pay.js, at order creation, from the CALLER's own
--      session (functions/lib/member-session.mjs:currentMember) -- never
--      from a user_id sent in the request body, which does not exist as a
--      field this endpoint reads.
--   2. functions/lib/purchase-link.mjs:confirmLinkOtp, when a signed-in
--      member proves ownership of the phone number on an OLD, still-unlinked
--      order by receiving and returning a one-time code sent to it -- never
--      from a name, phone or email typed into a form alone, and never
--      automatically from a LINE/Google identity.
--
-- No column here is ever used to look someone up by name/phone/email for
-- linking; it is only ever written from a value the server itself decided.
--
-- Validate on Preview (luma-db-preview) before Production. IF NOT EXISTS /
-- ADD COLUMN does not repair schema drift -- check PRAGMA table_info(payments)
-- for an existing owner_user_id column (with a different definition) before
-- re-running this on any database that might already have one.

ALTER TABLE payments ADD COLUMN owner_user_id TEXT
  CHECK(owner_user_id IS NULL OR length(owner_user_id) BETWEEN 16 AND 128);

CREATE INDEX IF NOT EXISTS idx_payments_owner ON payments(owner_user_id);
