// functions/api/member/entitlement.js — does the signed-in member already
// own a paid, unexpired order? Used so logging into the same account on a
// new device hands back access from the account, not from a phone number.
//
// This never issues a new token and never touches expires_at -- it only
// reads back whatever functions/lib/entitlement.mjs (webhook/verify) already
// wrote, filtered by owner_user_id instead of by token or phone.

import { authOrigin, currentMember } from '../../lib/member-session.mjs';
import { findOwnedEntitlement } from '../../lib/purchase-link.mjs';

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!authOrigin(env, request)) {
    return json({ ok: false, error: 'ระบบสมาชิกยังไม่พร้อมใช้งาน' }, 503);
  }

  let member;
  try {
    member = await currentMember(env, request);
  } catch (e) {
    console.error('member/entitlement: session check failed:', e);
    return json({ ok: false, error: 'ระบบสมาชิกยังไม่พร้อมใช้งาน' }, 503);
  }
  if (!member) return json({ ok: false, signedIn: false }, 401);

  try {
    const entitlement = await findOwnedEntitlement(env, member.id);
    if (!entitlement) return json({ ok: true, signedIn: true, hasEntitlement: false });
    if (entitlement.expired) return json({ ok: true, signedIn: true, hasEntitlement: false, expired: true });
    return json({
      ok: true, signedIn: true, hasEntitlement: true,
      token: entitlement.token, expiresAt: entitlement.expiresAt
    });
  } catch (e) {
    console.error('member/entitlement: lookup failed:', e);
    return json({ ok: false, error: 'เกิดข้อผิดพลาด กรุณาลองใหม่' }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
