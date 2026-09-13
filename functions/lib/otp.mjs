// functions/lib/otp.mjs — one-time codes for recovering access.
//
// Replaces the old "give me a phone number and I'll give you a token" recovery,
// which let anyone who knew a customer's phone number take over their access.
//
// Every limit below is enforced in the DATABASE, not in a Function's memory.
// Workers are per-request and horizontally scaled, so an in-memory counter
// resets constantly and is trivially bypassed by spreading requests out.
//
// What is deliberately NOT stored: the code itself. Only a salted hash is
// kept, so a leak of the table does not hand over working codes. Phone numbers
// are stored as their own hash too, so the table cannot be read as a list of
// paying customers.

export const OTP_POLICY = {
  codeLength: 6,
  ttlSeconds: 300,            // 5 minutes
  maxAttemptsPerCode: 5,      // wrong guesses before the code is burned
  maxSendsPerPhonePerHour: 3,
  minSecondsBetweenSends: 60,
  maxSendsPerIpPerHour: 10
};

// Digits only, and generated from a CSPRNG — not Math.random, which is
// predictable and would make codes guessable from earlier ones.
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
export function hashCode(pepper, phoneE164, code) {
  return sha256Hex(`${pepper}:${phoneE164}:${code}`);
}
export function hashPhone(pepper, phoneE164) {
  return sha256Hex(`${pepper}:phone:${phoneE164}`);
}
export function hashIp(pepper, ip) {
  return sha256Hex(`${pepper}:ip:${ip || 'unknown'}`);
}

export function timingSafeEqual(a, b) {
  const sa = String(a), sb = String(b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

/**
 * Thai mobile numbers to E.164 (66…). `payments.phone` is stored in the local
 * 0-prefixed form, so both shapes must land on the same value or a customer
 * would never be matched to their own order.
 */
export function toE164Thai(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (/^0\d{9}$/.test(digits))  return '66' + digits.slice(1);
  if (/^66\d{9}$/.test(digits)) return digits;
  if (/^\d{9}$/.test(digits))   return '66' + digits;
  return null;
}

/** The local 0-prefixed form used by payments.phone. */
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
 * Can we send another code to this phone / from this IP right now?
 * Counts real rows in the window — no memory state involved.
 */
export async function checkSendAllowed(env, { phoneHash, ipHash }) {
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            MAX(created_at) AS last_at
       FROM otp_challenges
      WHERE phone_hash = ? AND created_at > datetime('now', '-1 hour')`
  ).bind(phoneHash).first();

  if (recent && Number(recent.n) >= OTP_POLICY.maxSendsPerPhonePerHour) {
    return { allowed: false, reason: 'phone_hourly_limit' };
  }
  if (recent && recent.last_at) {
    const gap = await env.DB.prepare(
      `SELECT (julianday('now') - julianday(?)) * 86400 AS seconds`
    ).bind(recent.last_at).first();
    if (gap && Number(gap.seconds) < OTP_POLICY.minSecondsBetweenSends) {
      return { allowed: false, reason: 'too_soon' };
    }
  }

  const byIp = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM otp_challenges
      WHERE ip_hash = ? AND created_at > datetime('now', '-1 hour')`
  ).bind(ipHash).first();
  if (byIp && Number(byIp.n) >= OTP_POLICY.maxSendsPerIpPerHour) {
    return { allowed: false, reason: 'ip_hourly_limit' };
  }

  return { allowed: true };
}

export async function createChallenge(env, { phoneHash, ipHash, codeHash }) {
  await env.DB.prepare(
    `INSERT INTO otp_challenges (phone_hash, ip_hash, code_hash, created_at, expires_at, attempts)
     VALUES (?, ?, ?, datetime('now'), datetime('now', '+${OTP_POLICY.ttlSeconds} seconds'), 0)`
  ).bind(phoneHash, ipHash, codeHash).run();
}

/**
 * Check a submitted code. Consumption is a conditional UPDATE, so a code can
 * be redeemed exactly once even if two requests arrive together.
 */
export async function consumeChallenge(env, { phoneHash, codeHash }) {
  const row = await env.DB.prepare(
    `SELECT id, code_hash, attempts, consumed_at,
            (expires_at < datetime('now')) AS expired
       FROM otp_challenges
      WHERE phone_hash = ?
      ORDER BY id DESC LIMIT 1`
  ).bind(phoneHash).first();

  if (!row) return { ok: false, reason: 'no_challenge' };
  if (row.consumed_at) return { ok: false, reason: 'already_used' };
  if (Number(row.expired) === 1) return { ok: false, reason: 'expired' };
  if (Number(row.attempts) >= OTP_POLICY.maxAttemptsPerCode) return { ok: false, reason: 'too_many_attempts' };

  // Count the attempt BEFORE judging it, so a crash mid-check cannot give a
  // free guess, and so brute force is bounded even under concurrency.
  await env.DB.prepare(
    `UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?`
  ).bind(row.id).run();

  if (!timingSafeEqual(row.code_hash, codeHash)) return { ok: false, reason: 'wrong_code' };

  const res = await env.DB.prepare(
    `UPDATE otp_challenges SET consumed_at = datetime('now')
      WHERE id = ? AND consumed_at IS NULL`
  ).bind(row.id).run();

  if (changesOf(res) === 0) return { ok: false, reason: 'already_used' };
  return { ok: true, challengeId: row.id };
}
