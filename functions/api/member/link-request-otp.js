// functions/api/member/link-request-otp.js — step 1 of linking an old,
// pre-membership purchase to the caller's own signed-in account.
//
// Requires an active member session (CSRF-checked like /api/auth/logout);
// the account being linked to is always the caller's own -- there is no
// field for any other account id. Sends a code to the phone on the order,
// exactly like /api/request-otp, with the same privacy/throttle properties
// (see functions/lib/purchase-link.mjs and functions/lib/otp.mjs).

import { authOrigin, currentMember, sameOrigin } from '../../lib/member-session.mjs';
import { requestLinkOtp } from '../../lib/purchase-link.mjs';

export async function onRequestOptions() {
  return cors(null, 204);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const origin = authOrigin(env, request);
  if (!origin) return json({ error: 'ระบบสมาชิกยังไม่พร้อมใช้งาน' }, 503);
  if (!sameOrigin(request, origin)) return json({ error: 'คำขอไม่ถูกต้อง' }, 400);
  if (!env.OTP_PEPPER) {
    console.error('link-request-otp: OTP_PEPPER not configured — refusing');
    return json({ error: 'ระบบไม่พร้อมใช้งานชั่วคราว' }, 503);
  }

  let member;
  try {
    member = await currentMember(env, request);
  } catch (e) {
    return json({ error: 'ระบบสมาชิกยังไม่พร้อมใช้งาน' }, 503);
  }
  if (!member) return json({ error: 'กรุณาเข้าสู่ระบบก่อน' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  try {
    const ip = request.headers && request.headers.get ? (request.headers.get('cf-connecting-ip') || '') : '';
    const result = await requestLinkOtp(env, { phone: body && body.phone, ip, userId: member.id });
    return json(result, result.ok ? 200 : (result.status || 400));
  } catch (e) {
    console.error('link-request-otp error:', e);
    return json({ error: 'ระบบไม่พร้อมใช้งานชั่วคราว' }, 503);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
function cors(b, s = 200) {
  return new Response(b, { status: s, headers: {
    'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
}
