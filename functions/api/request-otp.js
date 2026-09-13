// functions/api/request-otp.js — step 1 of recovering access: send a code.
//
// PRIVACY RULE FOR THIS ENDPOINT: the response is identical whether or not the
// number belongs to a paying customer, and whether or not a message was sent.
// Anything else turns this into a free lookup service for "is this person a
// LUMA customer?" — so rate-limit refusals return the same body too.

import { OTP_POLICY, generateCode, hashCode, hashPhone, hashIp, toE164Thai, toLocalThai,
         checkSendAllowed, checkDailyCapAllowed, createChallenge, recordSendOutcome } from '../lib/otp.mjs';
import { sendSms } from '../lib/sms.mjs';

export async function onRequestOptions() { return cors(null, 204); }

// One response for every outcome. Never varied.
const SAME_ANSWER = { ok: true, message: 'หากเบอร์นี้มีสิทธิ์ใช้งานอยู่ ระบบได้ส่งรหัสยืนยันไปให้แล้ว' };

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.DB) return json({ error: 'ระบบไม่พร้อมใช้งานชั่วคราว' }, 503);
  if (!env.OTP_PEPPER) {
    // Fail closed: without the pepper the stored hashes would be brute-forceable.
    console.error('request-otp: OTP_PEPPER not configured — refusing');
    return json({ error: 'ระบบไม่พร้อมใช้งานชั่วคราว' }, 503);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const e164 = toE164Thai(body && body.phone);
  // A malformed number is a client mistake, not an enumeration signal, so this
  // one is safe to report plainly.
  if (!e164) return json({ error: 'รูปแบบเบอร์โทรไม่ถูกต้อง' }, 400);

  const pepper = env.OTP_PEPPER;
  const ip = request.headers && request.headers.get ? (request.headers.get('cf-connecting-ip') || '') : '';
  const phoneHash = await hashPhone(pepper, e164);
  const ipHash = await hashIp(pepper, ip);

  try {
    const allowed = await checkSendAllowed(env, { phoneHash, ipHash });
    if (!allowed.allowed) {
      console.log('request-otp: throttled (' + allowed.reason + ')');
      return json(SAME_ANSWER, 200);           // same answer as success
    }

    // Whole-system spend ceiling. Checked before anything is created or sent.
    const cap = await checkDailyCapAllowed(env);
    if (!cap.allowed) {
      // Loud for the operator, silent for the caller — the response must not
      // reveal that a cap exists, or it becomes a denial-of-service oracle.
      console.error('request-otp: DAILY SMS CAP REACHED (' + cap.used + '/' + cap.cap + ') — recovery unavailable until it rolls over');
      return json(SAME_ANSWER, 200);
    }

    const local = toLocalThai(e164);
    const row = await env.DB.prepare(
      `SELECT id FROM payments
        WHERE phone = ? AND status = 'paid'
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY paid_at DESC LIMIT 1`
    ).bind(local).first();

    // No entitlement → do the same amount of nothing, and say the same thing.
    if (!row) return json(SAME_ANSWER, 200);

    const code = generateCode();
    const codeHash = await hashCode(pepper, e164, code);
    const challengeId = await createChallenge(env, { phoneHash, ipHash, codeHash });

    const minutes = Math.round(OTP_POLICY.ttlSeconds / 60);
    const sent = await sendSms(env, {
      to: e164,
      text: `LUMA: รหัสยืนยันของคุณคือ ${code} (ใช้ได้ ${minutes} นาที) อย่าบอกรหัสนี้กับผู้อื่น`
    });
    // Never log the code, the number, or whether a customer exists.
    // One attempt only: no automatic retry loop and no failing over to a second
    // provider, either of which could deliver two codes for one request without
    // us knowing the first one's real outcome.
    await recordSendOutcome(env, challengeId, { provider: sent.provider, ok: sent.ok, reason: sent.reason });
    if (!sent.ok) console.error('request-otp: send failed (' + sent.reason + ')');

    return json(SAME_ANSWER, 200);
  } catch (e) {
    console.error('request-otp error');
    return json({ error: 'ระบบไม่พร้อมใช้งานชั่วคราว' }, 503);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
function cors(b, s = 200) {
  return new Response(b, { status: s, headers: {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
}
