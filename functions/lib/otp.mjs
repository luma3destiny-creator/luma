// functions/lib/otp.mjs — one-time codes for recovering access, and for
// linking an old, pre-membership purchase to a signed-in member account.
//
// Three properties this file exists to hold:
//
// 1. LIMITS ARE RESERVED, NOT CHECKED. Every limit is enforced by the database
//    as a SINGLE statement. An earlier draft counted rows and then inserted,
//    which is a time-of-check/time-of-use race: N simultaneous requests all read
//    "19 used" and all insert, blowing straight through a cap of 20. The quota
//    is now reserved by the same statement that records the request, so the
//    database's own write serialisation decides the winner.
//
// 2. A CHALLENGE ROW IS CREATED FOR EVERY REQUEST — customer or not. That is
//    deliberate: if rows only existed for real customers, the cooldown and the
//    hourly throttles would visibly behave differently for a customer's number
//    than for a stranger's, which turns this endpoint into a way to find out who
//    has paid. Rows for non-customers never reserve an SMS slot, so they cost
//    nothing and cannot be used to burn the daily cap.
//
// 3. THE DAILY SMS CAP IS RESERVED SEPARATELY, just before sending, and counts
//    only rows that actually reserved a send. Reserving it at insert time would
//    let a stranger's request consume a customer's budget; counting it after the
//    send would race.
//
// PURPOSE SEPARATION. Every challenge row is scoped, from the moment it is
// created, to exactly one purpose: 'recovery' (the phone/OTP recovery flow,
// pre-login) or 'link_purchase' (a signed-in member attaching an old order to
// their own account). consumeChallengeByPublicId refuses to consume a row for
// the wrong purpose, so a code sent for one flow can never be replayed into
// the other — a recovery code cannot be used to link an account, and a link
// code cannot be used to recover raw access. For 'link_purchase', the row also
// carries user_id and payment_id, both decided and stored at REQUEST time
// (never re-derived at confirm time) — see applyOwnerToOrder below for why.

export const OTP_POLICY = {
  codeLength: 6,
  ttlSeconds: 300,            // 5 minutes
  maxAttemptsPerCode: 5,      // wrong guesses before the code is burned
  maxSendsPerPhonePerHour: 3,
  minSecondsBetweenSends: 60,
  maxSendsPerIpPerHour: 10,
  // Whole-system ceiling per day. A SPEND cap, not a security control: it
  // bounds what a burst — or someone cycling through numbers — can cost.
  // Override with env.OTP_DAILY_SMS_CAP.
  //
  // The trade-off is real: once reached, genuine customers cannot recover
  // access until it rolls over. They are not locked out of the product (an
  // existing valid token keeps working), but recovery is unavailable.
  defaultDailySmsCap: 20
};


// Digits from a CSPRNG — not Math.random, which is predictable and would make
// codes guessable from earlier ones.
export function generateCode(length = OTP_POLICY.codeLength) {
  const digits = new Uint32Array(length);
  crypto.getRandomValues(digits);
  let out = '';
  for (let i = 0; i < length; i++) out += String(digits[i] % 10);
  return out;
}

export async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// The pepper is a secret held only in the environment. Without it, anyone who
// obtained the table could brute-force six-digit codes offline in moments.
export function hashCode(pepper, phoneE164, code) { return sha256Hex(`${pepper}:${phoneE164}:${code}`); }
export function hashPhone(pepper, phoneE164)      { return sha256Hex(`${pepper}:phone:${phoneE164}`); }
export function hashIp(pepper, ip)                { return sha256Hex(`${pepper}:ip:${ip || 'unknown'}`); }

export function timingSafeEqual(a, b) {
  const sa = String(a), sb = String(b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

/**
 * Thai mobile numbers to E.164 (66…). `payments.phone` is stored in the local
 * 0-prefixed form, so both shapes must land on the same value.
 */
export function toE164Thai(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (/^0\d{9}$/.test(digits))  return '66' + digits.slice(1);
  if (/^66\d{9}$/.test(digits)) return digits;
  if (/^\d{9}$/.test(digits))   return '66' + digits;
  return null;
}

export function toLocalThai(raw) {
  const e164 = toE164Thai(raw);
  return e164 ? '0' + e164.slice(2) : null;
}

function changesOf(result) {
  if (!result) return 0;
  if (result.meta && typeof result.meta.changes === 'number') return result.meta.changes;
  if (typeof result.changes === 'number') return result.changes;
  return 0;
}

function lastIdOf(result) {
  if (!result) return null;
  if (result.meta && result.meta.last_row_id != null) return result.meta.last_row_id;
  if (result.lastInsertRowid != null) return Number(result.lastInsertRowid);
  return null;
}

/**
 * Record a request and reserve one slot of the per-phone, per-IP and cooldown
 * budgets — in one statement — for EVERY caller, customer or not.
 *
 * Why one statement: SQLite (and D1 on top of it) serialises writers, so the
 * subquery counts and the insert are evaluated inside the same implicit
 * transaction. Two concurrent callers cannot both see room for the last slot.
 * Splitting this into a check and a later insert reintroduces the race.
 *
 * Why for everyone: so that a number nobody has ever paid with is throttled
 * exactly like a customer's number. See the header note.
 *
 * `purpose` scopes the row (see the file header); `userId`/`paymentId` are
 * only ever set for purpose='link_purchase' and are opaque to this function.
 * The throttles below are deliberately NOT scoped by purpose: a phone number
 * that can get 3 recovery codes an hour must not ALSO get 3 link codes on
 * top of that from the same number — one SMS budget per phone, regardless of
 * which flow is asking.
 *
 * Returns { ok:true, publicId, challengeId } or { ok:false, reason }.
 */
export async function reserveRequestSlot(env, { phoneHash, ipHash, codeHash, purpose = 'recovery', userId = null, paymentId = null }) {
  const publicId = crypto.randomUUID();

  const res = await env.DB.prepare(
    `INSERT INTO otp_challenges
        (public_id, phone_hash, ip_hash, code_hash, created_at, expires_at, attempts, sms_reserved, purpose, user_id, payment_id)
     SELECT ?1, ?2, ?3, ?4, datetime('now'), datetime('now', '+${OTP_POLICY.ttlSeconds} seconds'), 0, 0, ?7, ?8, ?9
      WHERE (SELECT COUNT(*) FROM otp_challenges
              WHERE phone_hash = ?2 AND created_at > datetime('now','-1 hour')) < ?5
        AND (SELECT COUNT(*) FROM otp_challenges
              WHERE ip_hash = ?3 AND created_at > datetime('now','-1 hour')) < ?6
        AND NOT EXISTS (SELECT 1 FROM otp_challenges
              WHERE phone_hash = ?2
                AND created_at > datetime('now','-${OTP_POLICY.minSecondsBetweenSends} seconds'))`
  ).bind(
    publicId, phoneHash, ipHash, codeHash,
    OTP_POLICY.maxSendsPerPhonePerHour, OTP_POLICY.maxSendsPerIpPerHour,
    purpose, userId, paymentId
  ).run();

  if (changesOf(res) === 0) return { ok: false, reason: 'throttled' };
  return { ok: true, publicId, challengeId: lastIdOf(res) };
}

/**
 * Reserve one unit of the whole-system daily SMS budget for a challenge that is
 * about to be sent. One statement again, for the same reason.
 *
 * Only rows that won this reservation count towards the cap, so requests for
 * numbers that are not customers — which never call this — cannot drain it.
 */
export async function reserveSmsSlot(env, challengeId) {
  const cap = Number(env.OTP_DAILY_SMS_CAP ?? OTP_POLICY.defaultDailySmsCap);
  if (!Number.isFinite(cap) || cap < 0) return { ok: false, reason: 'bad_cap_config' };

  const res = await env.DB.prepare(
    `UPDATE otp_challenges
        SET sms_reserved = 1
      WHERE id = ?1
        AND sms_reserved = 0
        AND (SELECT COUNT(*) FROM otp_challenges
              WHERE sms_reserved = 1
                AND created_at > datetime('now','-1 day')) < ?2`
  ).bind(challengeId, cap).run();

  if (changesOf(res) === 0) return { ok: false, reason: 'daily_cap_reached' };
  return { ok: true };
}

/**
 * Which limit actually blocked a request. For operator logs only — it is
 * advisory (read after the fact, so it can be slightly stale) and is never
 * surfaced to the caller.
 */
export async function diagnoseBlock(env, { phoneHash, ipHash }) {
  const cap = Number(env.OTP_DAILY_SMS_CAP ?? OTP_POLICY.defaultDailySmsCap);
  const day = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM otp_challenges
      WHERE sms_reserved = 1 AND created_at > datetime('now','-1 day')`).first();
  if (day && Number(day.n) >= cap) return { reason: 'daily_cap_reached', used: Number(day.n), cap };
  const phone = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM otp_challenges WHERE phone_hash = ? AND created_at > datetime('now','-1 hour')`
  ).bind(phoneHash).first();
  if (phone && Number(phone.n) >= OTP_POLICY.maxSendsPerPhonePerHour) return { reason: 'phone_hourly_limit' };
  const ip = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM otp_challenges WHERE ip_hash = ? AND created_at > datetime('now','-1 hour')`
  ).bind(ipHash).first();
  if (ip && Number(ip.n) >= OTP_POLICY.maxSendsPerIpPerHour) return { reason: 'ip_hourly_limit' };
  return { reason: 'cooldown' };
}

/**
 * Record how the send went. `status` is deliberately one of:
 *   'sent'    — the provider ACCEPTED the request. NOT proof of delivery.
 *   'failed'  — the provider refused, or we never got as far as asking.
 *   'unknown' — we asked but never learned the outcome (timeout / no response).
 *               These may well still have been sent, and may still be billed.
 */
export async function recordSendOutcome(env, challengeId, { provider, status, reason }) {
  if (!challengeId) return;
  await env.DB.prepare(
    `UPDATE otp_challenges SET provider = ?, send_status = ?, send_error = ? WHERE id = ?`
  ).bind(provider || null, status, reason || null, challengeId).run();
}

/**
 * Check a submitted code against a specific challenge, and reserve the token
 * that will be issued if it matches.
 *
 * Both the attempt counter and the consumption are conditional UPDATEs whose
 * guards live in the WHERE clause, so concurrent submissions cannot overspend
 * the attempt budget or redeem one code twice.
 *
 * ONLY THE NEWEST CODE WORKS. Asking for a new code has to retire the previous
 * one, or "resend" leaves two live codes for the same number and the older one
 * still opens the account. This is enforced as a CONDITION AT VERIFY TIME --
 * "refuse if a newer delivered challenge exists for this phone" -- rather than
 * by marking the old row when the new one is created. That choice matters: a
 * second write could be lost to a crash between the two statements, leaving the
 * old code alive, which is the bug itself. As a condition there is no window at
 * all, and no schema change.
 *
 * Only a newer challenge the provider ACCEPTED ('sent') or that may have gone
 * out ('unknown') retires an older one. A send the provider REFUSED never
 * reached the customer, so it must not take away the code they are holding --
 * that would strand them for no reason. A request that was throttled creates no
 * row and so retires nothing.
 *
 * The same condition is what stops an older challenge from overwriting a newer
 * token: only the newest challenge can ever reach `payments`.
 *
 * PURPOSE. `purpose` must match the row's own purpose exactly, or this refuses
 * the same as a wrong code -- a recovery challenge's public_id/code can never
 * be consumed as a link_purchase, and vice versa. For purpose='link_purchase'
 * the caller ALSO passes `userId`, which must match the row's own user_id
 * (the account that requested the link, bound at request time) -- so even a
 * link challenge's own owner cannot have it confirmed by a different signed-in
 * account than the one that asked for the code.
 *
 * CRASH WINDOW. Consuming the code and writing the outcome (a token onto a
 * payment row, or ownership onto one) are two different writes, and the worker
 * can die between them. So the outcome to be applied is decided and stored ON
 * THE CHALLENGE in the same statement that consumes it, and `token_applied`
 * records whether it was actually applied. A retry with the same code then
 * finishes the job — idempotent completion, not a second grant. (For
 * 'link_purchase' the stored `issued_token` is never itself used for
 * anything; it only exists to make the replay/idempotency mechanics below
 * identical for both purposes. See applyOwnerToOrder.)
 *
 * Returns { ok, challengeId, token, paymentId, replay } or { ok:false, reason }.
 */
export async function consumeChallengeByPublicId(env, { publicId, codeHash, candidateToken, purpose = 'recovery', userId = null }) {
  // Reserve an attempt. The guards are part of the write, so N parallel
  // guesses consume N attempts and stop exactly at the limit.
  const attempt = await env.DB.prepare(
    `UPDATE otp_challenges
        SET attempts = attempts + 1
      WHERE public_id = ?
        AND expires_at > datetime('now')
        AND attempts < ?
        AND (consumed_at IS NULL OR token_applied = 0)
        AND NOT EXISTS (
              SELECT 1 FROM otp_challenges AS newer
               WHERE newer.phone_hash = otp_challenges.phone_hash
                 AND newer.id > otp_challenges.id
                 AND newer.send_status IN ('sent', 'unknown'))`
  ).bind(publicId, OTP_POLICY.maxAttemptsPerCode).run();

  if (changesOf(attempt) === 0) return { ok: false, reason: 'not_attemptable' };

  const row = await env.DB.prepare(
    `SELECT id, code_hash, consumed_at, issued_token, token_applied, purpose, user_id, payment_id
       FROM otp_challenges WHERE public_id = ? LIMIT 1`
  ).bind(publicId).first();
  if (!row) return { ok: false, reason: 'not_found' };

  // Purpose/owner scoping happens before the code comparison, same as any
  // other rejection here: one message for every failure mode at the call
  // site, so this ordering leaks nothing extra.
  if (row.purpose !== purpose) return { ok: false, reason: 'wrong_purpose' };
  if (purpose === 'link_purchase' && String(row.user_id || '') !== String(userId || '')) {
    return { ok: false, reason: 'wrong_account' };
  }

  if (!timingSafeEqual(row.code_hash, codeHash)) return { ok: false, reason: 'wrong_code' };

  // Recovery path: this code was already accepted, but the outcome never
  // reached its target. Hand back the same token and let the caller finish.
  //
  // There is deliberately no time window here. A clock cannot tell a run that
  // died from a run that is merely slow -- a stalled request is still stalled
  // after ten seconds, or ten minutes -- so the safety is not in WHEN this
  // fires but in what the write itself is allowed to do: see applyTokenToOrder
  // / applyOwnerToOrder, each of which refuses any challenge that is no longer
  // the newest for that number, or that has already been applied. A duplicate
  // submission racing the original therefore gets the SAME outcome back,
  // never a second one, and a stalled older request can never land on top of
  // an outcome issued since.
  if (row.consumed_at && Number(row.token_applied) === 0 && row.issued_token) {
    return { ok: true, challengeId: row.id, token: row.issued_token, paymentId: row.payment_id, replay: true };
  }

  const consume = await env.DB.prepare(
    `UPDATE otp_challenges
        SET consumed_at = datetime('now'), issued_token = ?
      WHERE public_id = ? AND consumed_at IS NULL`
  ).bind(candidateToken, publicId).run();

  if (changesOf(consume) === 0) return { ok: false, reason: 'already_used' };
  return { ok: true, challengeId: row.id, token: candidateToken, paymentId: row.payment_id, replay: false };
}

/**
 * Write this challenge's token onto the order -- in ONE statement that re-checks,
 * at the moment of writing, that the challenge is still allowed to write.
 *
 * This is the control that makes concurrency safe, and it is a write condition
 * rather than a timer. Two guards live in the WHERE clause:
 *
 *   token_applied = 0   this challenge has not already been applied, so a
 *                       replay cannot write twice.
 *   no newer challenge  the number has not been sent a newer code since. A
 *                       request that stalled -- for ten seconds or ten minutes,
 *                       the duration is irrelevant -- and resumes after the
 *                       customer already recovered with a newer code will find
 *                       this false and write nothing, instead of silently
 *                       replacing the token they are holding.
 *
 * Because the check and the write are the same statement, nothing can change
 * between them.
 */
export async function applyTokenToOrder(env, { publicId, orderId, token }) {
  const res = await env.DB.prepare(
    `UPDATE payments
        SET token = ?1
      WHERE id = ?2
        AND EXISTS (
              SELECT 1 FROM otp_challenges c
               WHERE c.public_id = ?3
                 AND c.token_applied = 0
                 AND NOT EXISTS (
                       SELECT 1 FROM otp_challenges n
                        WHERE n.phone_hash = c.phone_hash
                          AND n.id > c.id
                          AND n.send_status IN ('sent', 'unknown')))`
  ).bind(token, orderId, publicId).run();

  if (changesOf(res) === 0) return { applied: false };

  // Only now stop holding the token on the challenge. If the worker dies
  // between these two statements the token is already on the order, and the
  // retry simply finds token_applied still 0, rewrites the same value, and
  // finishes -- which changes nothing.
  await env.DB.prepare(
    `UPDATE otp_challenges SET token_applied = 1, issued_token = NULL WHERE public_id = ?`
  ).bind(publicId).run();
  return { applied: true };
}

/**
 * Write this challenge's OWN bound payment_id/user_id onto `payments.owner_user_id`
 * -- the link-flow analogue of applyTokenToOrder above, with the identical
 * crash-safety shape:
 *
 *   - the row to link and the account to link it to are NOT re-derived here.
 *     Both are read from the challenge itself (payment_id, user_id), exactly as
 *     they were decided and stored at REQUEST time by requestLinkOtp. There is
 *     no "pick the latest still-unlinked order" query anywhere in this
 *     function -- the whole point is that the order a code was sent about
 *     cannot silently change to a different one between request and confirm.
 *   - `owner_user_id IS NULL` in the WHERE clause is what makes two concurrent
 *     link attempts for orders that happen to name the same payment_id safe:
 *     only the first UPDATE to actually run can win: the second finds
 *     owner_user_id no longer NULL and writes nothing.
 *   - `status = 'paid' AND datetime(expires_at) > datetime('now')` is the
 *     same fail-closed expiry rule every paid API uses -- a code accepted
 *     while the order was live must not still grant ownership of an order
 *     that has since expired, been refunded, or been cancelled.
 *   - `c.consumed_at IS NOT NULL` is the property that actually proves a
 *     code was verified for THIS challenge. It is checked here, in the
 *     write itself, rather than trusted from the caller's own call order --
 *     confirmLinkOtp always calls consumeChallengeByPublicId first today,
 *     but this function must not depend on that being true; a fresh,
 *     never-consumed challenge (consumed_at IS NULL) must never be able to
 *     write ownership just because something else called this directly.
 *   - `token_applied = 0` + the "no newer challenge for this phone" guard is
 *     the exact same replay/staleness protection applyTokenToOrder uses, so a
 *     process that dies after consumeChallengeByPublicId but before this call
 *     resumes safely on retry: the caller re-consumes (gets the replay branch
 *     above, same token back) and calls this again, which is a no-op if it
 *     already succeeded, or completes the job if it did not.
 *
 * RETRY AFTER THE OWNER WRITE SUCCEEDED BUT token_applied NEVER GOT SET.
 * The crash this function survives can land between its own two statements:
 * `payments.owner_user_id` gets written, then the process dies before
 * `token_applied` is marked. The retry below must finish that exact
 * interrupted write -- and ONLY that -- without assuming that "owner_user_id
 * already equals this challenge's user_id" proves THIS challenge is the one
 * that set it: two different challenges can legitimately share the same
 * user_id/payment_id (the same member asking to link the same still-unlinked
 * order twice before either is confirmed), so that equality alone proves
 * nothing about which challenge actually ran the write. What DOES prove it is
 * checking, on retry, every precondition the write itself required, applied
 * to THIS challenge specifically: it must still be consumed
 * (`consumed_at IS NOT NULL` -- a code was genuinely verified for this exact
 * challenge, never assumed from call order), still current (not superseded
 * by a newer request for the same phone), and not yet marked applied. A
 * challenge that fails any of those was never the one whose write this is,
 * so it is never finished here even if the order happens to already be
 * owned by its account through a different, equally-valid challenge.
 *
 * Returns { applied: true } once owner_user_id is set (on this call or an
 * earlier one that crashed before marking token_applied), or
 * { applied: false } if there was nothing valid left to apply -- the order is
 * already linked (to this account or another), no longer paid/live, the
 * challenge is stale, unconsumed, or was never a valid link challenge.
 */
export async function applyOwnerToOrder(env, { publicId }) {
  const res = await env.DB.prepare(
    `UPDATE payments
        SET owner_user_id = (SELECT user_id FROM otp_challenges WHERE public_id = ?1)
      WHERE owner_user_id IS NULL
        AND status = 'paid'
        AND datetime(expires_at) > datetime('now')
        AND id = (SELECT payment_id FROM otp_challenges WHERE public_id = ?1)
        AND EXISTS (
              SELECT 1 FROM otp_challenges c
               WHERE c.public_id = ?1
                 AND c.purpose = 'link_purchase'
                 AND c.payment_id IS NOT NULL
                 AND c.user_id IS NOT NULL
                 AND c.consumed_at IS NOT NULL
                 AND c.token_applied = 0
                 AND NOT EXISTS (
                       SELECT 1 FROM otp_challenges n
                        WHERE n.phone_hash = c.phone_hash
                          AND n.id > c.id
                          AND n.send_status IN ('sent', 'unknown')))`
  ).bind(publicId).run();

  if (changesOf(res) > 0) {
    // Only now stop holding the token on the challenge -- same shape as
    // applyTokenToOrder. If the worker dies between these two statements,
    // `payments.owner_user_id` is already written and the branch below is
    // what finishes the job on retry.
    await env.DB.prepare(
      `UPDATE otp_challenges SET token_applied = 1, issued_token = NULL WHERE public_id = ?`
    ).bind(publicId).run();
    return { applied: true };
  }

  // The write above changed nothing just now. Find out whether that is a
  // genuine refusal or the interrupted-retry case -- by re-checking THIS
  // challenge against every precondition the write itself requires, never
  // by inferring success from the order's current owner alone.
  const row = await env.DB.prepare(
    `SELECT p.owner_user_id, c.user_id, c.payment_id, c.token_applied, c.consumed_at,
            NOT EXISTS (
                  SELECT 1 FROM otp_challenges n
                   WHERE n.phone_hash = c.phone_hash
                     AND n.id > c.id
                     AND n.send_status IN ('sent', 'unknown')) AS still_current
       FROM otp_challenges c
       LEFT JOIN payments p ON p.id = c.payment_id
      WHERE c.public_id = ?1 AND c.purpose = 'link_purchase'`
  ).bind(publicId).first();

  const thisChallengeWasVerifiedAndEligible =
    row &&
    Number(row.token_applied) === 0 &&
    row.consumed_at != null &&
    Number(row.still_current) === 1 &&
    row.payment_id != null;

  const orderAlreadyOwnedByThisAccount =
    row && row.owner_user_id != null && String(row.owner_user_id) === String(row.user_id);

  if (thisChallengeWasVerifiedAndEligible && orderAlreadyOwnedByThisAccount) {
    await env.DB.prepare(
      `UPDATE otp_challenges SET token_applied = 1, issued_token = NULL WHERE public_id = ?`
    ).bind(publicId).run();
    return { applied: true };
  }

  return { applied: false };
}

/** Close out a challenge that will never hand its token over. */
export async function abandonIssuedToken(env, publicId) {
  await env.DB.prepare(
    `UPDATE otp_challenges SET token_applied = 1, issued_token = NULL WHERE public_id = ?`
  ).bind(publicId).run();
}

/** The phone hash a challenge was created for — used to find the order. */
export async function challengePhoneHash(env, publicId) {
  const row = await env.DB.prepare(
    `SELECT phone_hash FROM otp_challenges WHERE public_id = ? LIMIT 1`
  ).bind(publicId).first();
  return row ? row.phone_hash : null;
}
