// functions/api/check-access.js — verify token or phone, return unlock status

import { currentMember } from '../lib/member-session.mjs';

export async function onRequestOptions() {
  return cors(null, 204);
}

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!env.DB) return json({ ok: false, error: 'Database not configured' }, 500);

  const url   = new URL(request.url);
  const token = url.searchParams.get('token');
  const phone = url.searchParams.get('phone');

  if (!token && !phone) return json({ ok: false }, 400);

  try {
    if (token) {
      // Verify by token (normal page-load check).
      // NOTE: the hard-coded `if (token === 'dev-token') return ok:true`
      // that used to sit here was a free-access bypass — removed.
      //
      // Expiry rule: datetime(expires_at) > datetime('now'), evaluated by
      // SQLite/D1 itself — the SAME rule functions/lib/paid-access.mjs uses
      // for every paid API. NULL and any string SQLite cannot parse as a
      // datetime both fail this comparison, so a broken row is never
      // treated as "not expired" (a plain JS `if (row.expires_at && ...)`
      // would let a NULL expiry straight through, which is exactly the bug
      // this replaced).
      const row = await env.DB.prepare(
        `SELECT id, owner_user_id, expires_at,
                (datetime(expires_at) > datetime('now')) AS live
           FROM payments WHERE token = ? AND status = 'paid' LIMIT 1`
      ).bind(token).first();

      if (!row) return json({ ok: false });
      if (!row.live) return json({ ok: false, expired: true });

      // Owner-bound token, MANDATORY (see functions/lib/paid-access.mjs's
      // header for the full rationale): the caller must be signed in, right
      // now, as the exact account this row is bound to. A row with no owner
      // is REFUSED OUTRIGHT for anyone -- there are no legacy customers
      // behind this rollout, so a NULL owner is dead data, never a
      // still-valid anonymous entitlement.
      if (!row.owner_user_id) {
        return json({ ok: false });
      }
      let member = null;
      try {
        member = await currentMember(env, request);
      } catch (e) {
        console.error('check-access: session lookup failed for an owner-bound token:', e);
        return json({ ok: false, error: 'เกิดข้อผิดพลาด กรุณาลองใหม่' }, 503);
      }
      if (!member || String(member.id) !== String(row.owner_user_id)) {
        return json({ ok: false });
      }

      return json({ ok: true, expiresAt: row.expires_at });
    }

    if (phone) {
      // ── Phone-only recovery: PERMANENTLY RETIRED ────────────────────────
      // Knowing a phone number is not proof of owning it, and entitlements
      // are now bound to signed-in member accounts (LINE/Google) at
      // purchase time -- there is no recovery-by-phone case left to serve,
      // and no prior-purchase data behind this rollout that still needs it.
      //
      // This is an unconditional 410: it does not read `payments`, does not
      // rotate a token, and -- deliberately -- does not check
      // PURCHASE_RECOVERY_DISABLED or OTP_RECOVERY_ENABLED. Neither flag
      // defaulted to closed (an unset/stale PURCHASE_RECOVERY_DISABLED left
      // this path OPEN), so keeping this behind either of them would mean a
      // missing or old env value could silently reopen it. The token branch
      // above is unaffected: presenting a token you already hold is not
      // recovery and stays open.
      return json({
        ok: false, code: 'RECOVERY_RETIRED',
        error: 'ระบบกู้คืนสิทธิ์ด้วยเบอร์โทรปิดใช้งานแล้ว กรุณาเข้าสู่ระบบด้วยบัญชี LINE หรือ Google'
      }, 410);
    }

  } catch (e) {
    console.error('check-access error:', e);
    return json({ ok: false, error: 'เกิดข้อผิดพลาด' }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function cors(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
