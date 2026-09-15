# AI access and repeated-request audit

Policy confirmed by owner: five-topic reading is free; compatibility and
face/palm analysis require paid, unexpired access.

Changes:
- Compatibility and vision share a D1 token check requiring a valid future expiry.
  Compatibility no longer authorizes via a legacy Redis charge ID. Current browser
  requests already send the saved token, including after /api/verify succeeds.
  Missing, malformed and expired dates fail closed, as do DB failures.
- Free reading remains free. Its loader reuses completed identical payloads for
  ten minutes in page memory (maximum five results) and coalesces identical pending
  submissions. Cache hits do not automatically email again. Different payloads
  retain the existing stale-response guard. Refreshing the page clears this cache.

Validation: node --test tests/paid-ai.mjs tests/reading-loader.mjs tests/email-security.mjs
Nine tests passed with local SQLite and mocked provider requests. No real AI,
SMS, email, production deployment or database migration was performed.

What remains:
- No server-side rate limit exists on these three AI handlers. Browser caching is
  an optimization, not abuse protection. Set separate paid/free budgets and add
  atomic server-side reservations before enabling broader AI testing.
- generate-reading-1.js is also a routable legacy free AI handler; any future
  spending guard must cover or retire it, otherwise it bypasses the new guard.
- No first-request latency measurement or model-quality comparison was made.
  Model selection, prompt length and streaming remain unchanged.
- Production phone-only recovery remains a source of tokens until OTP rollout.
  These paid checks do not fix that separate recovery weakness.
- Existing paid records with missing/invalid expiry now need investigation rather
  than being silently accepted as unlimited. No payment dates or tokens were changed.

No new variables or migrations are needed for these changes. Preview verification
with no AI key can check denial paths; real speed needs an explicitly authorized
provider call or the mocked loader tests, not a claim based on deployment success.
