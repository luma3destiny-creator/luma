// functions/lib/otp.mjs — one-time codes for recovering access.
//
// Replaces the old "give me a phone number and I'll give you a token" recovery,
// which let anyone who knew a customer's phone number take over their access.
//
// Every limit is enforced in the DATABASE, and — importantly — as a SINGLE
// statement. An earlier draft counted rows and then inserted, which is a
// time-of-check/time-of-use race: N simultaneous requests all read "19 used"
// and all insert, blowing straight through a cap of 20. The quota is now
// RESERVED by the same statement that creates the challenge, so the database's
// own write serialisation decides the winner and the cap holds exactly.

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

/**
 * Reserve one unit of every relevant quota AND create the challenge, in one
 * statement. Returns the public challenge id on success.
 *
 * Why one statement: SQLite (and D1 on top of it) serialises writers, so the
 * subquery counts and the insert are evaluated inside the same implicit
 * transaction. Two concurrent callers cannot both see room for the last slot.
 * Splitting this into a check and a later insert would reintroduce the race.
 *
 * Returns { ok:true, publicId, challengeId } or { ok:false, reason }.
 */
export async function reserveAndCreateChallenge(env, { phoneHash, ipHash, codeHash }) {
  const cap = Number(env.OTP_DAILY_SMS_CAP ?? OTP_POLICY.defaultDailySmsCap);
  if (!Number.isFinite(cap) || cap < 0) return { ok: false, reason: 'bad_cap_config' };

  const publicId = crypto.randomUUID();

  const res = await env.DB.prepare(
    `INSERT INTO otp_challenges
        (public_id, phone_hash, ip_hash, code_hash, created_at, expires_at, attempts)
     SELECT ?1, ?2, ?3, ?4, datetime('now'), datetime('now', '+${OTP_POLICY.ttlSeconds} seconds'), 0
      WHERE (SELECT COUNT(*) FROM otp_challenges
              WHERE created_at > datetime('now','-1 day')) < ?5
        AND (SELECT COUNT(*) FROM otp_challenges
              WHERE phone_hash = ?2 AND created_at > datetime('now','-1 hour')) < ?6
        AND (SELECT COUNT(*) FROM otp_challenges
              WHERE ip_hash = ?3 AND created_at > datetime('now','-1 hour')) < ?7
        AND NOT EXISTS (SELECT 1 FROM otp_challenges
              WHERE phone_hash = ?2
                AND created_at > datetime('now','-${OTP_POLICY.minSecondsBetweenSends} seconds'))`
  ).bind(
    publicId, phoneHash, ipHash, codeHash,
    cap, OTP_POLICY.maxSendsPerPhonePerHour, OTP_POLICY.maxSendsPerIpPerHour
  ).run();

  if (changesOf(res) === 0) return { ok: false, reason: 'quota_or_throttle' };
  return { ok: true, publicId, challengeId: (res.meta && res.meta.last_row_id) || null };
}

/**
 * Which limit actually blocked a reservation. For operator logs only — it is
 * advisory (read after the fact, so it can be slightly stale) and is never
 * surfaced to the caller.
 */
export async function diagnoseBlock(env, { phoneHash, ipHash }) {
  const cap = Number(env.OTP_DAILY_SMS_CAP ?? OTP_POLICY.defaultDailySmsCap);
  const day = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM otp_challenges WHERE created_at > datetime('now','-1 day')`).first();
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
 * Check a submitted code against a specific challenge.
 *
 * Both the attempt counter and the consumption are conditional UPDATEs whose
 * guards live in the WHERE clause, so concurrent submissions cannot overspend
 * the attempt budget or redeem one code twice.
 */
export async function consumeChallengeByPublicId(env, { publicId, codeHash }) {
  // Reserve an attempt. The guards are part of the write, so N parallel
  // guesses consume N attempts and stop exactly at the limit.
  const attempt = await env.DB.prepare(
    `UPDATE otp_challenges
        SET attempts = attempts + 1
      WHERE public_id = ?
        AND consumed_at IS NULL
        AND expires_at > datetime('now')
        AND attempts < ?`
  ).bind(publicId, OTP_POLICY.maxAttemptsPerCode).run();

  if (changesOf(attempt) === 0) return { ok: false, reason: 'not_attemptable' };

  const row = await env.DB.prepare(
    `SELECT id, code_hash FROM otp_challenges WHERE public_id = ? LIMIT 1`
  ).bind(publicId).first();
  if (!row) return { ok: false, reason: 'not_found' };

  if (!timingSafeEqual(row.code_hash, codeHash)) return { ok: false, reason: 'wrong_code' };

  const consume = await env.DB.prepare(
    `UPDATE otp_challenges SET consumed_at = datetime('now')
      WHERE public_id = ? AND consumed_at IS NULL`
  ).bind(publicId).run();

  if (changesOf(consume) === 0) return { ok: false, reason: 'already_used' };
  return { ok: true, challengeId: row.id };
}

/** The phone hash a challenge was created for — used to find the order. */
export async function challengePhoneHash(env, publicId) {
  const row = await env.DB.prepare(
    `SELECT phone_hash FROM otp_challenges WHERE public_id = ? LIMIT 1`
  ).bind(publicId).first();
  return row ? row.phone_hash : null;
}
