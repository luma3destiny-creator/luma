// functions/api/verify-otp.js — step 2 of recovery: prove ownership, get a token.
//
// A token is issued ONLY after a code that we sent to that number is returned
// correctly, within its lifetime, within the attempt budget, and unused.
//
// Consuming the code and writing the new token onto the payment row are two
// separate writes and the worker can die between them. The token is therefore
// decided and stored on the challenge in the same statement that consumes the
// code; if the second write never happened, presenting the same code again
// finishes the job and returns the SAME token. That is recovery, not a second
// grant — see consumeChallengeByPublicId.

import { hashCode, hashPhone, toE164Thai, toLocalThai,
         consumeChallengeByPublicId, markTokenApplied, challengePhoneHash } from '../lib/otp.mjs';

export async function onRequestOptions() { return cors(null, 204); }

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.DB) return json({ error: 'ระบบไม่พร้อมใช้งานชั่วคราว' }, 503);
  if (!env.OTP_PEPPER) {
    console.error('verify-otp: OTP_PEPPER not configured — refusing');
    return json({ error: 'ระบบไม่พร้อมใช้งานชั่วคราว' }, 503);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const e164 = toE164Thai(body && body.phone);
  const code = typeof (body && body.code) === 'string' ? body.code.trim() : '';
  const challengeId = typeof (body && body.challengeId) === 'string' ? body.challengeId.trim() : '';
  if (!e164 || !challengeId || !/^\d{4,8}$/.test(code)) {
    return json({ ok: false, error: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุแล้ว' }, 400);
  }

  const pepper = env.OTP_PEPPER;
  const phoneHash = await hashPhone(pepper, e164);
  const codeHash = await hashCode(pepper, e164, code);

  try {
    // The challenge must belong to the number being claimed, or a challenge
    // created for one number could be paired with another number's code.
    const boundHash = await challengePhoneHash(env, challengeId);
    if (!boundHash || boundHash !== phoneHash) {
      return json({ ok: false, error: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุแล้ว' }, 401);
    }

    const result = await consumeChallengeByPublicId(env, {
      publicId: challengeId,
      codeHash,
      candidateToken: crypto.randomUUID()
    });
    if (!result.ok) {
      // One message for every failure mode: a caller must not learn whether the
      // code was wrong, expired, already used, or never existed.
      console.log('verify-otp: rejected (' + result.reason + ')');
      return json({ ok: false, error: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุแล้ว' }, 401);
    }

    const local = toLocalThai(e164);
    const row = await env.DB.prepare(
      `SELECT id, expires_at FROM payments
        WHERE phone = ? AND status = 'paid'
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY paid_at DESC LIMIT 1`
    ).bind(local).first();

    // A correct code for a number with no live entitlement. Nothing to hand
    // over, and the same message as every other rejection.
    if (!row) {
      await markTokenApplied(env, result.challengeId);   // stop holding a token we will not use
      return json({ ok: false, error: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุแล้ว' }, 401);
    }

    // Rotate the token: whoever just proved ownership gets the one reserved for
    // this challenge, and any token a previous holder had stops working. Writing
    // the same value twice (after a crash-and-retry) is a no-op, not a regrant.
    await env.DB.prepare(`UPDATE payments SET token = ? WHERE id = ?`).bind(result.token, row.id).run();
    await markTokenApplied(env, result.challengeId);

    if (result.replay) console.log('verify-otp: completed a token issue that was interrupted earlier');
    return json({ ok: true, token: result.token, expiresAt: row.expires_at });
  } catch (e) {
    console.error('verify-otp error');
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
