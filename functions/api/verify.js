// functions/api/verify.js — check Stripe PaymentIntent status, issue token, save to D1

export async function onRequestOptions() {
  return cors(null, 204);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Payment service not configured' }, 500);
  if (!env.DB)                return json({ error: 'Database not configured' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { chargeId } = body;
  if (!chargeId) return json({ error: 'ข้อมูลไม่ครบ' }, 400);

  // Dev bypass
  if (chargeId === 'dev') {
    return json({ ok: true, token: 'dev-token' });
  }

  try {
    // Check Stripe PaymentIntent status
    const res  = await fetch(`https://api.stripe.com/v1/payment_intents/${chargeId}`, {
      headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` }
    });
    const data = await res.json();

    if (!res.ok) return json({ error: 'ไม่พบรายการชำระเงิน' }, 404);

    if (data.status !== 'succeeded') {
      return json({ error: 'การชำระเงินยังไม่สำเร็จ รอสักครู่แล้วลองใหม่' }, 402);
    }

    // Look up the pending record for this charge
    const row = await env.DB.prepare(
      `SELECT id, phone, token FROM payments WHERE charge_id = ?`
    ).bind(chargeId).first();

    if (!row) return json({ error: 'ไม่พบข้อมูลการชำระเงิน' }, 404);

    // Reuse existing token or generate new one
    const token = row.token || crypto.randomUUID();

    await env.DB.prepare(
      `UPDATE payments SET status='paid', token=?, paid_at=datetime('now'), expires_at=datetime('now','+1 month') WHERE charge_id=?`
    ).bind(token, chargeId).run();

    return json({ ok: true, token });

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
