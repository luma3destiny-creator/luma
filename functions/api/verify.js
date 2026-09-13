// functions/api/verify.js — confirm a Stripe PaymentIntent and grant access.
//
// The payment rules live in functions/lib/entitlement.mjs and are shared with
// /api/stripe-webhook, so the browser path and the webhook path can never
// disagree about what counts as paid or hand out two different entitlements
// for the same order.
//
// Behaviour change vs the previous version: re-checking an order that is
// already paid no longer rewrites paid_at/expires_at. It returns the stored
// values untouched. Previously every call reset the expiry to "now + 1 month",
// which meant access could be renewed for free by replaying this endpoint.

import { validatePaymentIntent, grantEntitlementOnce, fetchPaymentIntent } from '../lib/entitlement.mjs';

export async function onRequestOptions() {
  return cors(null, 204);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Payment service not configured' }, 500);
  if (!env.DB)                return json({ error: 'Database not configured' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const chargeId = typeof body.chargeId === 'string' ? body.chargeId.trim() : '';
  if (!chargeId) return json({ error: 'ข้อมูลไม่ครบ' }, 400);

  // Dev bypass REMOVED — see git history. Paid access comes only from a
  // Stripe-confirmed PaymentIntent. Use Preview + a test-mode key to exercise
  // this flow without real money.

  try {
    // The order must exist on our side before we ask Stripe anything, so an
    // unknown id can't be used to probe Stripe through our credentials.
    const order = await env.DB.prepare(
      `SELECT id, amount, status, charge_id FROM payments WHERE charge_id = ? LIMIT 1`
    ).bind(chargeId).first();

    if (!order) return json({ error: 'ไม่พบข้อมูลการชำระเงิน' }, 404);

    const pi = await fetchPaymentIntent(env, chargeId);
    if (!pi.ok) return json({ error: 'ไม่พบรายการชำระเงิน' }, 404);

    const check = validatePaymentIntent(pi.data, order);
    if (!check.ok) return json({ error: check.error, code: check.code }, check.status);

    const grant = await grantEntitlementOnce(env, chargeId);
    if (!grant.ok) return json({ error: grant.error, code: grant.code }, grant.status);

    // `granted` is true only for the call that actually created the
    // entitlement; replays return the same stored values.
    return json({
      ok: true,
      token: grant.token,
      expiresAt: grant.expires_at,
      firstGrant: grant.granted
    });

  } catch (e) {
    console.error('verify error:', e);
    return json({ error: 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง' }, 500);
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
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
