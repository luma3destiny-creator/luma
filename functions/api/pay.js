// functions/api/pay.js — create Stripe PromptPay PaymentIntent + save to D1

export async function onRequestOptions() {
  return cors(null, 204);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Payment service not configured' }, 500);
  if (!env.DB)                return json({ error: 'Database not configured' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const phone = normalizePhone(body.phone);
  if (!phone) return json({ error: 'กรุณากรอกเบอร์โทรศัพท์ให้ถูกต้อง' }, 400);

  const name      = sanitizeName(body.name);
  const birthdate = sanitizeBirthdate(body.birthdate);
  const birthplace = sanitizeName(body.birthplace);

  try {
    // Create a Stripe PaymentIntent confirmed with PromptPay — Stripe returns
    // a QR code (PNG/SVG hosted images + raw EMV data) in next_action.
    // Stripe requires a billing email for PromptPay charges. We don't collect
    // one at this step, so synthesize a stable placeholder from the phone number.
    const billingEmail = `${phone}@customers.luma-9qx.pages.dev`;

    const params = new URLSearchParams({
      amount: '5900',
      currency: 'thb',
      'payment_method_types[]': 'promptpay',
      'payment_method_data[type]': 'promptpay',
      'payment_method_data[billing_details][email]': billingEmail,
      confirm: 'true'
    });

    const res = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });

    const data = await res.json();
    if (!res.ok) return json({ error: data.error?.message || 'ระบบชำระเงินขัดข้อง กรุณาลองใหม่' }, 502);

    const chargeId    = data.id; // PaymentIntent id (pi_...) — plays the role Omise's charge id used to
    const qrCodeUrl   = data.next_action?.promptpay_display_qr_code?.image_url_png || null;
    const hostedUrl   = data.next_action?.promptpay_display_qr_code?.hosted_instructions_url || null;

    // Save to D1 — upsert by phone (overwrite any old pending charge)
    await env.DB.prepare(
      `INSERT INTO payments (phone, name, birthdate, birthplace, charge_id, amount, status)
       VALUES (?, ?, ?, ?, ?, 5900, 'pending')
       ON CONFLICT(charge_id) DO UPDATE SET phone=excluded.phone, name=excluded.name, birthdate=excluded.birthdate, birthplace=excluded.birthplace, status='pending'`
    ).bind(phone, name, birthdate, birthplace, chargeId).run();

    return json({ chargeId, qrCodeUrl, hostedUrl });

  } catch (e) {
    console.error('pay error:', e);
    return json({ error: 'ไม่สามารถเชื่อมต่อระบบชำระเงิน กรุณาลองใหม่' }, 502);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function sanitizeName(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim().slice(0, 100);
  return trimmed || null;
}

function sanitizeBirthdate(raw) {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw).trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = parseInt(y, 10), month = parseInt(mo, 10), day = parseInt(d, 10);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${mo}-${d}`;
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('0')) return digits;
  if (digits.length === 9) return '0' + digits;          // dropped leading 0
  if (digits.length === 11 && digits.startsWith('66')) return '0' + digits.slice(2);
  return null;
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
