// Shared authorization for paid AI endpoints. Missing/invalid expiry fails closed.
//
// OWNER-BOUND TOKENS. Once a payment row has been linked to a member account
// (payments.owner_user_id is set -- see functions/lib/purchase-link.mjs), the
// bare token is no longer sufficient on its own: the caller must ALSO be
// signed in, right now, as that exact account. A token that worked for
// account A stops working the moment A signs out, and never works under a
// different signed-in account B -- both are enforced here, on every call,
// by checking the CURRENT request's own session against the row's owner.
// A row with owner_user_id still NULL (every purchase made before member
// accounts existed, and every purchase made signed-out today) is completely
// unaffected: the token alone still works exactly as it always has. This is
// deliberate backward compatibility, not an oversight -- see
// migrations/015_payments_owner.sql.
import { currentMember } from './member-session.mjs';

export async function checkPaidAccess(context, token) {
  const { env, request } = context;
  if (typeof token !== 'string' || !token.trim() || token.length > 256 || ['dev', 'dev-token'].includes(token.trim())) {
    return { ok: false, status: 402, error: 'กรุณากู้คืนสิทธิ์หรือชำระเงินก่อนใช้งานส่วนนี้' };
  }
  if (!env.DB) return { ok: false, status: 503, error: 'ระบบตรวจสิทธิ์ยังไม่พร้อม กรุณาลองภายหลัง' };
  let row;
  try {
    // datetime(expires_at) > datetime('now') is the ONE expiry rule used
    // everywhere access is granted (see functions/lib/purchase-link.mjs's
    // header for the fuller version of this note). NULL and any string
    // SQLite cannot parse both fail this comparison, so a broken row is
    // never treated as "not expired".
    row = await env.DB.prepare(
      "SELECT id, owner_user_id FROM payments WHERE token = ? AND status = 'paid' AND datetime(expires_at) > datetime('now') LIMIT 1"
    ).bind(token.trim()).first();
  } catch {
    return { ok: false, status: 503, error: 'ระบบตรวจสิทธิ์ยังไม่พร้อม กรุณาลองภายหลัง' };
  }
  if (!row) return { ok: false, status: 402, error: 'สิทธิ์ไม่ถูกต้องหรือหมดอายุ กรุณากู้คืนสิทธิ์' };

  if (row.owner_user_id) {
    let member = null;
    try {
      member = await currentMember(env, request);
    } catch {
      // A session cookie was presented but validating it failed (DB error,
      // etc). Fail closed -- never fall through to treating an owner-bound
      // token as valid without actually checking the owner.
      return { ok: false, status: 503, error: 'ระบบตรวจสิทธิ์ยังไม่พร้อม กรุณาลองภายหลัง' };
    }
    if (!member || String(member.id) !== String(row.owner_user_id)) {
      return { ok: false, status: 401, error: 'กรุณาเข้าสู่ระบบด้วยบัญชีที่เป็นเจ้าของสิทธิ์นี้' };
    }
  }

  return { ok: true, paymentId: row.id };
}
