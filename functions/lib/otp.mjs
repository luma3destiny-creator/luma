// functions/lib/otp.mjs — one-time codes for recovering access.
//
// Replaces the old "give me a phone number and I'll give you a token" recovery,
// which let anyone who knew a customer's phone number take over their access.
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

// How long after a code was accepted the interrupted-issue recovery path may
// be used. Long enough that a person retrying qualifies, short enough that a
// concurrent sibling request never does.
const RECOVERY_MIN_AGE_SECONDS = 10;

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
 * Returns { ok:true, publicId, challengeId } or { ok:false, reason }.
 */
export async function reserveRequestSlot(env, { phoneHash, ipHash, codeHash }) {
  const publicId = crypto.randomUUID();

  const res = await env.DB.prepare(
    `INSERT INTO otp_challenges
        (public_id, phone_hash, ip_hash, code_hash, created_at, expires_at, attempts, sms_reserved)
     SELECT ?1, ?2, ?3, ?4, datetime('now'), datetime('now', '+${OTP_POLICY.ttlSeconds} seconds'), 0, 0
      WHERE (SELECT COUNT(*) FROM otp_challenges
              WHERE phone_hash = ?2 AND created_at > datetime('now','-1 hour')) < ?5
        AND (SELECT COUNT(*) FROM otp_challenges
              WHERE ip_hash = ?3 AND created_at > datetime('now','-1 hour')) < ?6
        AND NOT EXISTS (SELECT 1 FROM otp_challenges
              WHERE phone_hash = ?2
                AND created_at > datetime('now','-${OTP_POLICY.minSecondsBetweenSends} seconds'))`
  ).bind(
    publicId, phoneHash, ipHash, codeHash,
    OTP_POLICY.maxSendsPerPhonePerHour, OTP_POLICY.maxSendsPerIpPerHour
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
 * CRASH WINDOW. Consuming the code and writing the new token onto the payment
 * row are two different writes, and the worker can die between them. If that
 * happened and the code were simply burned, the customer would have paid, held
 * a valid code, and still got nothing. So the token to be issued is decided and
 * stored ON THE CHALLENGE in the same statement that consumes it, and
 * `token_applied` records whether it reached `payments`. A retry with the same
 * code then finishes the job and returns the SAME token — which is idempotent
 * recovery, not a second grant.
 *
 * Returns { ok, challengeId, token, replay } or { ok:false, reason }.
 */
export async function consumeChallengeByPublicId(env, { publicId, codeHash, candidateToken }) {
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
    `SELECT id, code_hash, consumed_at, issued_token, token_applied,
            (consumed_at IS NOT NULL
             AND consumed_at <= datetime('now', '-${RECOVERY_MIN_AGE_SECONDS} seconds')) AS recoverable
       FROM otp_challenges WHERE public_id = ? LIMIT 1`
  ).bind(publicId).first();
  if (!row) return { ok: false, reason: 'not_found' };

  if (!timingSafeEqual(row.code_hash, codeHash)) return { ok: false, reason: 'wrong_code' };

  // Recovery path: this code was already accepted, but the token never reached
  // the payment row. Hand back the same token and let the caller finish.
  //
  // `recoverable` is what keeps this from firing on a sibling request that is
  // simply a few milliseconds behind: mid-flight, a run that has consumed the
  // code but not yet written the token looks exactly like a run that died. The
  // age check separates them, because a real retry is a person submitting the
  // form again and is never this fast. Without it, two simultaneous submissions
  // both answer 200 -- with the same token and one grant, so nothing is
  // over-issued, but "this code worked twice" is not a thing to leave true.
  if (Number(row.recoverable) === 1 && Number(row.token_applied) === 0 && row.issued_token) {
    return { ok: true, challengeId: row.id, token: row.issued_token, replay: true };
  }

  const consume = await env.DB.prepare(
    `UPDATE otp_challenges
        SET consumed_at = datetime('now'), issued_token = ?
      WHERE public_id = ? AND consumed_at IS NULL`
  ).bind(candidateToken, publicId).run();

  if (changesOf(consume) === 0) return { ok: false, reason: 'already_used' };
  return { ok: true, challengeId: row.id, token: candidateToken, replay: false };
}

/** Mark the issued token as delivered to `payments`, and stop storing it. */
export async function markTokenApplied(env, challengeId) {
  await env.DB.prepare(
    `UPDATE otp_challenges SET token_applied = 1, issued_token = NULL WHERE id = ?`
  ).bind(challengeId).run();
}

/** The phone hash a challenge was created for — used to find the order. */
export async function challengePhoneHash(env, publicId) {
  const row = await env.DB.prepare(
    `SELECT phone_hash FROM otp_challenges WHERE public_id = ? LIMIT 1`
  ).bind(publicId).first();
  return row ? row.phone_hash : null;
}
