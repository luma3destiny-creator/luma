// functions/lib/purchase-link.mjs — connect a member account to the paid
// orders it actually owns, without ever trusting a name/phone/email typed
// into a form as proof of ownership.
//
// Two separate operations live here:
//
//   findOwnedEntitlement(env, userId) — READ-ONLY. Does this signed-in
//     member already own a paid, LIVE (non-null, non-malformed, unexpired)
//     order? Used so that logging into the same account on a new device
//     hands back the entitlement that account already has, instead of
//     asking for a phone number again. It never mints a token and never
//     touches expires_at -- both are read back exactly as the
//     webhook/verify flow wrote them (functions/lib/entitlement.mjs is
//     still the only place those columns are written). Its expiry rule is
//     the SAME SQL-level rule functions/lib/paid-access.mjs uses for every
//     paid API: `datetime(expires_at) > datetime('now')`, evaluated by the
//     database, never re-implemented in JS date arithmetic. A NULL or
//     malformed expires_at fails that comparison and grants nothing --
//     there is no separate, looser rule for this path.
//
//   requestLinkOtp / confirmLinkOtp — an explicit, verified action a
//     SIGNED-IN member takes to attach one specific OLD order (bought before
//     member accounts existed, so its owner_user_id is still NULL) to their
//     own account. "Verified" means the same proof request-otp.js and
//     verify-otp.js already require for recovery: a one-time code sent to
//     the phone number ON THE ORDER, read back correctly. These two
//     functions reuse that exact machinery (functions/lib/otp.mjs) --
//     same throttles, same hashing, same "only the newest code works"
//     guarantee -- so linking cannot be done with a phone number alone, or
//     with a name/email at all.
//
//     Both the account (userId) and the SPECIFIC order (paymentId) are
//     decided ONCE, at request time, and stored on the otp_challenges row
//     itself (see migrations/016_otp_challenges_purpose.sql). confirmLinkOtp
//     never re-selects "the latest unlinked order for this phone" -- it
//     only ever acts on the row the challenge was created for. That is what
//     makes a second order arriving (or a second link request for the same
//     phone) between request and confirm harmless, and what makes retrying
//     after a crash between "code accepted" and "ownership written" safe:
//     see functions/lib/otp.mjs's consumeChallengeByPublicId and
//     applyOwnerToOrder for the full mechanics, which mirror the
//     already-reviewed recovery flow's own crash/replay handling exactly.
//
//     The challenge is also scoped by PURPOSE ('link_purchase', never
//     'recovery') and by the REQUESTING ACCOUNT: consumeChallengeByPublicId
//     refuses a purpose or account mismatch the same way it refuses a wrong
//     code, so a recovery code can never be replayed here, and a link
//     challenge requested by one signed-in account can never be confirmed by
//     a different one, even with the right code.
//
// What this file will NEVER do:
//   - accept a phone match, name match or email match as proof by itself
//     and link on that basis;
//   - link automatically from a LINE/Google identity;
//   - issue a new token, rewrite an existing token, or change expires_at.
//     Those stay exactly as grantEntitlementOnce/the webhook wrote them.

import { OTP_POLICY, generateCode, hashCode, hashPhone, hashIp, toE164Thai, toLocalThai,
         reserveRequestSlot, reserveSmsSlot, recordSendOutcome,
         consumeChallengeByPublicId, applyOwnerToOrder, challengePhoneHash } from './otp.mjs';
import { sendSms } from './sms.mjs';

/**
 * Read-only lookup of a paid, LIVE order already owned by this member.
 *
 * Returns:
 *   null                          — no owned order at all (never bought, or
 *                                    every owned order has expired/lapsed,
 *                                    or its expiry is missing/malformed --
 *                                    same fail-closed rule as every paid
 *                                    API; see the file header).
 *   { expired: true }             — owned an order, but it has lapsed.
 *   { token, expiresAt }          — a live entitlement, exactly as stored.
 */
export async function findOwnedEntitlement(env, userId) {
  if (!userId) return null;

  // The ONLY expiry rule used anywhere access is granted:
  // datetime(expires_at) > datetime('now'), evaluated by SQLite/D1 itself.
  // NULL and any string SQLite cannot parse as a datetime both fail this
  // comparison (it evaluates to NULL, which WHERE treats as false) --
  // exactly like functions/lib/paid-access.mjs:checkPaidAccess. There is no
  // "if expires_at is falsy, skip the check" branch here.
  const live = await env.DB.prepare(
    `SELECT token, expires_at FROM payments
      WHERE owner_user_id = ? AND status = 'paid' AND datetime(expires_at) > datetime('now')
      ORDER BY expires_at DESC LIMIT 1`
  ).bind(userId).first();

  if (live) {
    if (!live.token) return null; // paid but incomplete row; nothing to hand back
    return { token: live.token, expiresAt: live.expires_at };
  }

  // No LIVE entitlement. This second query exists only to choose the right
  // MESSAGE (expired vs. never bought) -- it grants nothing by itself, and
  // is never used in place of the expiry-filtered query above.
  const any = await env.DB.prepare(
    `SELECT id FROM payments WHERE owner_user_id = ? AND status = 'paid' LIMIT 1`
  ).bind(userId).first();
  return any ? { expired: true } : null;
}

// Same response shape for every outcome, on purpose -- see request-otp.js.
// This cannot be used to probe which phone numbers have an unlinked order:
// a stranger's number, a customer's already-linked number, and a customer's
// genuinely-unlinked number all get the same answer.
function sameAnswer(challengeId) {
  return {
    ok: true,
    challengeId,
    message: 'หากเบอร์นี้มีสิทธิ์ที่ยังไม่ผูกกับบัญชีใด ระบบได้ส่งรหัสยืนยันไปให้แล้ว'
  };
}

/**
 * Step 1 of linking. `userId` is the CALLER's own signed-in account id --
 * required (the route already enforces a session before calling this, but
 * this function refuses on its own too, so it is never reachable without
 * one even if a future caller forgets the check).
 *
 * The specific order to link is picked HERE, once, and bound onto the
 * otp_challenges row this call creates (via reserveRequestSlot's
 * userId/paymentId columns) -- confirmLinkOtp will act on THIS row's
 * payment_id later, never a fresh "latest unlinked" lookup. That is what
 * stops the target from silently changing between request and confirm.
 */
export async function requestLinkOtp(env, { phone, ip, userId }) {
  if (!userId) return { ok: false, status: 401, error: 'กรุณาเข้าสู่ระบบก่อน' };

  const e164 = toE164Thai(phone);
  if (!e164) return { ok: false, status: 400, error: 'รูปแบบเบอร์โทรไม่ถูกต้อง' };

  const pepper = env.OTP_PEPPER;
  const phoneHash = await hashPhone(pepper, e164);
  const ipHash = await hashIp(pepper, ip || '');
  const code = generateCode();
  const codeHash = await hashCode(pepper, e164, code);

  const local = toLocalThai(e164);
  // Picked ONCE, now. The same fail-closed expiry rule as everywhere else
  // (see findOwnedEntitlement above) -- NULL/malformed expires_at is never
  // "not expired", so a broken row can never be linked either.
  const target = await env.DB.prepare(
    `SELECT id FROM payments
      WHERE phone = ? AND status = 'paid' AND owner_user_id IS NULL
        AND datetime(expires_at) > datetime('now')
      ORDER BY paid_at DESC LIMIT 1`
  ).bind(local).first();

  const reserved = await reserveRequestSlot(env, {
    phoneHash, ipHash, codeHash,
    purpose: 'link_purchase', userId, paymentId: target ? target.id : null
  });
  if (!reserved.ok) return sameAnswer(crypto.randomUUID()); // decoy id, same as request-otp.js

  if (!target) return sameAnswer(reserved.publicId);

  const slot = await reserveSmsSlot(env, reserved.challengeId);
  if (!slot.ok) return sameAnswer(reserved.publicId);

  const minutes = Math.round(OTP_POLICY.ttlSeconds / 60);
  let sent;
  try {
    sent = await sendSms(env, {
      to: e164,
      code,
      text: `LUMA: รหัสยืนยันสำหรับเชื่อมสิทธิ์เดิมของคุณคือ ${code} (ใช้ได้ ${minutes} นาที) อย่าบอกรหัสนี้กับผู้อื่น`
    });
  } catch (e) {
    sent = { ok: false, status: 'unknown', reason: 'no_response', provider: env.SMS_PROVIDER || 'mock' };
  }
  await recordSendOutcome(env, reserved.challengeId, {
    provider: sent.provider,
    status: sent.status || (sent.ok ? 'sent' : 'failed'),
    reason: sent.ok ? null : sent.reason
  });
  if (!sent.ok) console.error('link-request-otp: send not confirmed (' + (sent.status || 'failed') + '/' + sent.reason + ')');

  return sameAnswer(reserved.publicId);
}

/**
 * Step 2 of linking. `userId` is the CALLER's own signed-in account id, read
 * by the route from the session cookie -- never from anything in the request
 * body. This must be the SAME account that called requestLinkOtp: the
 * purpose+account check inside consumeChallengeByPublicId enforces that (see
 * functions/lib/otp.mjs), so presenting a correct code while signed in as a
 * DIFFERENT account than the one that requested it is refused just like a
 * wrong code, before ownership is ever considered.
 *
 * On success this writes owner_user_id on exactly the order the challenge
 * was created for (never a fresh "latest unlinked" lookup) to the caller's
 * own account. It never touches `token` or `expires_at`.
 */
export async function confirmLinkOtp(env, { userId, phone, code, challengeId }) {
  if (!userId) return { ok: false, status: 401, error: 'กรุณาเข้าสู่ระบบก่อน' };

  const e164 = toE164Thai(phone);
  const codeStr = typeof code === 'string' ? code.trim() : '';
  const idStr = typeof challengeId === 'string' ? challengeId.trim() : '';
  if (!e164 || !idStr || !/^\d{4,8}$/.test(codeStr)) {
    return { ok: false, status: 400, error: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุแล้ว' };
  }

  const pepper = env.OTP_PEPPER;
  const phoneHash = await hashPhone(pepper, e164);
  const codeHash = await hashCode(pepper, e164, codeStr);

  // The challenge must belong to the number being claimed -- same guard
  // verify-otp.js uses, so a challenge created for one number cannot be
  // paired with a code for another.
  const boundHash = await challengePhoneHash(env, idStr);
  if (!boundHash || boundHash !== phoneHash) {
    return { ok: false, status: 401, error: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุแล้ว' };
  }

  // purpose:'link_purchase' + userId here is what makes this refuse a
  // recovery challenge's id/code outright (wrong_purpose), and refuse a
  // link challenge requested by a DIFFERENT signed-in account (wrong_account)
  // -- both rejected the same way as a wrong code, before any DB write.
  const result = await consumeChallengeByPublicId(env, {
    publicId: idStr, codeHash, candidateToken: crypto.randomUUID(),
    purpose: 'link_purchase', userId
  });
  if (!result.ok) {
    console.log('link-verify-otp: rejected (' + result.reason + ')');
    return { ok: false, status: 401, error: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุแล้ว' };
  }

  // Links the row the CHALLENGE was created for (payment_id, bound at
  // request time) to the CHALLENGE's own user_id -- never a fresh lookup,
  // never the caller-supplied userId directly. Idempotent and crash-safe:
  // see functions/lib/otp.mjs:applyOwnerToOrder for the full guarantee. A
  // retry after a crash between consume and this call re-consumes into the
  // `replay` branch above (same token back) and lands here again, which
  // either finishes the job or is a safe no-op if it already succeeded.
  const linked = await applyOwnerToOrder(env, { publicId: idStr });
  if (!linked.applied) {
    return {
      ok: false, status: 404,
      error: 'ไม่พบสิทธิ์ที่ยังไม่ผูกบัญชีสำหรับเบอร์นี้ อาจถูกผูกไปแล้วหรือหมดอายุ'
    };
  }
  if (result.replay) console.log('link-verify-otp: completed a link that was interrupted earlier');
  return { ok: true };
}
