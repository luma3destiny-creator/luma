// functions/api/request-otp.js — step 1 of recovering access: send a code.
//
// PRIVACY RULE FOR THIS ENDPOINT: the response is identical whether or not the
// number belongs to a paying customer, and whether or not a message was sent.
// Anything else turns this into a free lookup service for "is this person a
// LUMA customer?" — so rate-limit refusals return the same body too.
//
// That rule covers more than the response body. A challenge row is written for
// EVERY request, so the cooldown and the hourly throttles behave the same for a
// stranger's number as for a customer's; if rows existed only for customers,
// asking twice in a minute would tell you who had paid. Rows for non-customers
// never reserve an SMS slot, so they cost nothing and cannot drain the cap.
//
// The one difference that remains is timing: a customer's request additionally
// calls the SMS provider, which takes longer. Closing that would mean making a
// throwaway provider call for every stranger — real money for no message — so
// it is left open, and written down here rather than pretended away.

import { OTP_POLICY, generateCode, hashCode, hashPhone, hashIp, toE164Thai, toLocalThai,
         reserveRequestSlot, reserveSmsSlot, diagnoseBlock, recordSendOutcome } from '../lib/otp.mjs';
import { sendSms } from '../lib/sms.mjs';

export async function onRequestOptions() { return cors(null, 204); }

// One response shape for every outcome. The challengeId is ALWAYS present —
// a real one when a slot was won, a fresh random decoy when it was not — so the
// response cannot be used to tell whether a number belongs to a customer.
function sameAnswer(challengeId) {
  return {
    ok: true,
    challengeId,
    message: 'หากเบอร์นี้มีสิทธิ์ใช้งานอยู่ ระบบได้ส่งรหัสยืนยันไปให้แล้ว'
  };
}

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
    // Generated before we know whether this number is a customer, so the same
    // work happens either way. For a non-customer the code is never sent and
    // never guessable, which is what makes the row harmless.
    const code = generateCode();
    const codeHash = await hashCode(pepper, e164, code);

    // Throttles are RESERVED by the same statement that records the request —
    // see reserveRequestSlot. This runs for every number.
    const reserved = await reserveRequestSlot(env, { phoneHash, ipHash, codeHash });
    if (!reserved.ok) {
      const why = await diagnoseBlock(env, { phoneHash, ipHash });
      console.log('request-otp: throttled (' + why.reason + ')');
      return json(sameAnswer(crypto.randomUUID()), 200);   // decoy id
    }

    const local = toLocalThai(e164);
    const row = await env.DB.prepare(
      `SELECT id FROM payments
        WHERE phone = ? AND status = 'paid'
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY paid_at DESC LIMIT 1`
    ).bind(local).first();

    // Not a customer: the row stays, nothing is sent, no SMS budget is spent.
    if (!row) return json(sameAnswer(reserved.publicId), 200);

    // Spend budget is reserved separately and only now, so a stranger's request
    // can never consume a customer's share of it.
    const slot = await reserveSmsSlot(env, reserved.challengeId);
    if (!slot.ok) {
      if (slot.reason === 'daily_cap_reached') {
        console.error('request-otp: DAILY SMS CAP REACHED — recovery unavailable until it rolls over');
      } else {
        console.error('request-otp: cannot reserve send slot (' + slot.reason + ')');
      }
      return json(sameAnswer(reserved.publicId), 200);
    }

    const minutes = Math.round(OTP_POLICY.ttlSeconds / 60);
    let sent;
    try {
      sent = await sendSms(env, {
        to: e164,
        code,
        text: `LUMA: รหัสยืนยันของคุณคือ ${code} (ใช้ได้ ${minutes} นาที) อย่าบอกรหัสนี้กับผู้อื่น`
      });
    } catch (e) {
      // We asked and never learned the outcome. It may have been sent, and it
      // may still be billed — so it is recorded as 'unknown', not 'failed'.
      sent = { ok: false, status: 'unknown', reason: 'no_response', provider: env.SMS_PROVIDER || 'mock' };
    }

    // One attempt only: no automatic retry and no failing over to a second
    // provider, either of which could deliver two codes for one request
    // without us knowing the first one's real outcome.
    await recordSendOutcome(env, reserved.challengeId, {
      provider: sent.provider,
      status: sent.status || (sent.ok ? 'sent' : 'failed'),
      reason: sent.ok ? null : sent.reason
    });
    // Never log the code, the number, or whether a customer exists.
    if (!sent.ok) console.error('request-otp: send not confirmed (' + (sent.status || 'failed') + '/' + sent.reason + ')');

    return json(sameAnswer(reserved.publicId), 200);
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
