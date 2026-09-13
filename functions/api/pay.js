// functions/api/pay.js — create Stripe PromptPay PaymentIntent + save to D1
//
// TRANSITIONAL VERSION (cutover step): production is moving from sending a
// raw birthdate to sending a pre-computed `age`. Some browsers may still
// have the OLD app.html cached (open tab from before this deploy, or a
// stale service-worker/CDN edge cache) and will still POST `birthdate`
// instead of `age`. This version accepts EITHER shape during the
// transition, but:
//   - a birthdate that arrives here is used ONLY to compute an age, in
//     memory, for this one request — it is NEVER written to D1 and NEVER
//     written to any log line (only a content-free counter marker is
//     logged, so Cloudflare Logs can be used to see when the fallback
//     stops being hit).
//   - once env.BIRTHDATE_FALLBACK_ENABLED is set to the literal string
//     "false" (see below), a birthdate-only request is rejected with a
//     clear "please refresh" error instead of being silently accepted or
//     silently failing — see REJECTED_STALE_CLIENT below.
//
// Remove this fallback branch entirely once Cloudflare Logs show zero
// birthdate_fallback_used hits for a full monitoring window AND you're
// comfortable stale tabs older than that window no longer matter.

import { computeAgeAtPurchase } from '../lib/age.mjs';

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

  const name = sanitizeName(body.name);
  const birthplace = sanitizeName(body.birthplace);

  // ── age resolution: prefer client-computed `age`; fall back to a
  // transient in-memory computation from `birthdate` for stale clients ──
  let age = sanitizeAge(body.age);
  const hasAge = body.age !== undefined && body.age !== null && body.age !== '';
  const hasBirthdate = typeof body.birthdate === 'string' && body.birthdate.trim() !== '';

  if (!hasAge && hasBirthdate) {
    const fallbackEnabled = env.BIRTHDATE_FALLBACK_ENABLED !== 'false';

    if (!fallbackEnabled) {
      // Fallback has been switched off — don't silently accept a stale
      // request and don't silently fail either. Tell the client exactly
      // what to do; app.html should show this message and prompt a
      // hard refresh (cache-busted) rather than retrying the same call.
      return json({
        error: 'กรุณารีเฟรชหน้าเว็บแล้วลองใหม่อีกครั้ง (เวอร์ชันหน้าเว็บที่คุณใช้อยู่ล้าสมัยแล้ว)',
        code: 'STALE_CLIENT_REFRESH_REQUIRED'
      }, 409);
    }

    // Content-free marker only — never log the birthdate value itself,
    // and it is never persisted to D1 either (see the INSERT below).
    console.log('[pay] birthdate_fallback_used=1');

    const computed = computeAgeAtPurchase(body.birthdate, new Date());
    age = computed.age; // null if invalid/future/unparseable — never guessed
    // computed.reason is intentionally discarded here: it must never be
    // logged next to phone/name, and D1 has nowhere to put it (see the
    // audit report's recommendation to report NULL-reason breakdowns only
    // from the backfill script's own aggregate counts, not per-request).
  }

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

    // Save to D1 — upsert by phone (overwrite any old pending charge).
    // NOTE: birthdate is intentionally absent from this column list, even
    // though the `birthdate` column still physically exists on the table
    // (phase 3 drop is a separate, later, explicitly-approved step). Every
    // row written by this version of the code leaves birthdate untouched
    // at its column default (NULL for a brand-new row).
    await env.DB.prepare(
      `INSERT INTO payments (phone, name, age_at_purchase, birthplace, charge_id, amount, status)
       VALUES (?, ?, ?, ?, ?, 5900, 'pending')
       ON CONFLICT(charge_id) DO UPDATE SET phone=excluded.phone, name=excluded.name, age_at_purchase=excluded.age_at_purchase, birthplace=excluded.birthplace, status='pending'`
    ).bind(phone, name, age, birthplace, chargeId).run();

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

function sanitizeAge(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) return null;
  if (n < 0 || n > 130) return null; // same plausibility bound as functions/lib/age.mjs
  return n;
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
