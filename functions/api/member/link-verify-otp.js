// functions/api/member/link-verify-otp.js — step 2 of linking: prove the
// code, then attach the caller's OWN signed-in account (from the session,
// never from the request body) to the newest unlinked paid order for that
// phone. Never issues or rewrites a token; never changes expires_at.

import { authOrigin, currentMember, sameOrigin } from '../../lib/member-session.mjs';
import { confirmLinkOtp } from '../../lib/purchase-link.mjs';

export async function onRequestOptions() {
  return cors(null, 204);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const origin = authOrigin(env, request);
  if (!origin) return json({ ok: false, error: 'ระบบสมาชิกยังไม่พร้อมใช้งาน' }, 503);
  if (!sameOrigin(request, origin)) return json({ ok: false, error: 'คำขอไม่ถูกต้อง' }, 400);
  if (!env.OTP_PEPPER) {
    console.error('link-verify-otp: OTP_PEPPER not configured — refusing');
    return json({ ok: false, error: 'ระบบไม่พร้อมใช้งานชั่วคราว' }, 503);
  }

  let member;
  try {
    member = await currentMember(env, request);
  } catch (e) {
    return json({ ok: false, error: 'ระบบสมาชิกยังไม่พร้อมใช้งาน' }, 503);
  }
  if (!member) return json({ ok: false, error: 'กรุณาเข้าสู่ระบบก่อน' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  try {
    const result = await confirmLinkOtp(env, {
      userId: member.id,
      phone: body && body.phone,
      code: body && body.code,
      challengeId: body && body.challengeId
    });
    return json(result, result.ok ? 200 : (result.status || 400));
  } catch (e) {
    console.error('link-verify-otp error:', e);
    return json({ ok: false, error: 'ระบบไม่พร้อมใช้งานชั่วคราว' }, 503);
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
