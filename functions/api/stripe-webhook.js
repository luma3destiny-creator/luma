// functions/api/stripe-webhook.js — receive payment confirmations from Stripe.
//
// Why this exists: PromptPay is asynchronous. The customer scans the QR in
// their banking app and the payment may settle after they have closed the
// page, so nothing ever calls /api/verify and they never get access even
// though they paid. Stripe pushes the event here instead.
//
// Signature verification follows Stripe's documented manual procedure:
//   header:  t=<unix ts>,v1=<hex hmac>[,v1=<hex hmac>…][,v0=…]
//   payload: "<t>.<raw body>"
//   digest:  HMAC-SHA256 keyed with the endpoint signing secret
// Only the v1 scheme is accepted (ignoring other schemes is what prevents a
// downgrade attack), several v1 signatures may be present while a secret is
// being rolled, comparison is constant-time, and a timestamp outside the
// tolerance window is rejected to blunt replays.
//
// This endpoint NEVER returns an access token. It is an unauthenticated public
// URL: anyone can POST to it, and only the signature tells us Stripe sent it.
// Returning a token here would hand entitlements to whoever calls it.
//
// Secrets are per-environment. Preview and Production each need their own
// STRIPE_WEBHOOK_SECRET matching their own STRIPE_SECRET_KEY — a test-mode
// endpoint's secret will never validate live-mode events, and mixing them is
// exactly how a test payment ends up granting real access.

import { validatePaymentIntent, grantEntitlementOnce, markEventSeen } from '../lib/entitlement.mjs';

const DEFAULT_TOLERANCE_SECONDS = 300; // Stripe's own default; never set to 0

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.DB) {
    console.error('stripe-webhook: no DB binding');
    return text('database unavailable', 503);
  }
  if (!env.STRIPE_WEBHOOK_SECRET) {
    // Fail closed: without the secret we cannot tell Stripe from an impostor.
    console.error('stripe-webhook: STRIPE_WEBHOOK_SECRET not configured — refusing');
    return text('webhook not configured', 503);
  }

  // The RAW body, byte for byte. Parsing it first and re-serialising would
  // change the bytes and break the signature.
  const rawBody = await request.text();
  const sigHeader = request.headers.get('stripe-signature') || '';

  const verified = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET, {
    toleranceSeconds: Number(env.STRIPE_WEBHOOK_TOLERANCE || DEFAULT_TOLERANCE_SECONDS)
  });
  if (!verified.ok) {
    console.warn('stripe-webhook: signature rejected:', verified.reason);
    return text('invalid signature', 400);
  }

  let event;
  try { event = JSON.parse(rawBody); } catch { return text('invalid payload', 400); }

  const eventId = event && typeof event.id === 'string' ? event.id : null;
  const eventType = event && typeof event.type === 'string' ? event.type : '';
  if (!eventId) return text('invalid event', 400);

  // Only the event we actually need. Anything else is acknowledged so Stripe
  // stops retrying, but does nothing.
  if (eventType !== 'payment_intent.succeeded') {
    return text('ignored', 200);
  }

  try {
    // Duplicate delivery guard. Stripe explicitly does not guarantee
    // exactly-once delivery or ordering, so the same event can arrive twice.
    // (The grant below is idempotent on its own; this just makes replays cheap.)
    const isNew = await markEventSeen(env, eventId, eventType);
    if (!isNew) return text('duplicate ignored', 200);

    const pi = event.data && event.data.object;
    const chargeId = pi && typeof pi.id === 'string' ? pi.id : null;
    if (!chargeId) return text('no payment intent id', 200);

    const order = await env.DB.prepare(
      `SELECT id, amount, status, charge_id FROM payments WHERE charge_id = ? LIMIT 1`
    ).bind(chargeId).first();

    // An event for something we have no order for is not an error on Stripe's
    // side — acknowledge it rather than making Stripe retry forever.
    if (!order) {
      console.warn('stripe-webhook: no matching order for this payment intent');
      return text('no matching order', 200);
    }

    const check = validatePaymentIntent(pi, order);
    if (!check.ok) {
      console.warn('stripe-webhook: payment intent rejected:', check.code);
      // Deliberately 200: the event was genuinely from Stripe, it just does not
      // entitle anyone. Retrying would not change that.
      return text('not entitled: ' + check.code, 200);
    }

    const grant = await grantEntitlementOnce(env, chargeId);
    if (!grant.ok) {
      if (grant.code === 'ENTITLEMENT_INCOMPLETE') {
        console.error('stripe-webhook: order needs manual review');
        return text('needs manual review', 200);
      }
      // A real failure on our side — let Stripe retry.
      console.error('stripe-webhook: grant failed:', grant.code);
      return text('grant failed', 500);
    }

    // No token in the response. The customer collects it from /api/verify or
    // the recovery flow, both of which authenticate the caller.
    console.log('stripe-webhook: processed (firstGrant=' + grant.granted + ')');
    return text('ok', 200);

  } catch (e) {
    console.error('stripe-webhook error:', e);
    return text('error', 500); // 5xx so Stripe retries
  }
}

// Anything other than a signed POST gets nothing useful.
export async function onRequestGet() { return text('method not allowed', 405); }

// ── signature verification ───────────────────────────────────────────────────

export async function verifyStripeSignature(rawBody, sigHeader, secret, { toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, nowSeconds = null } = {}) {
  if (!sigHeader) return { ok: false, reason: 'missing header' };
  if (!secret)    return { ok: false, reason: 'missing secret' };

  let timestamp = null;
  const v1Signatures = [];
  for (const part of String(sigHeader).split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') v1Signatures.push(value); // ignore v0 and any future scheme
  }

  if (!timestamp || !/^\d+$/.test(timestamp)) return { ok: false, reason: 'no timestamp' };
  if (v1Signatures.length === 0) return { ok: false, reason: 'no v1 signature' };

  if (toleranceSeconds > 0) {
    const now = nowSeconds != null ? nowSeconds : Math.floor(Date.now() / 1000);
    const age = Math.abs(now - Number(timestamp));
    if (age > toleranceSeconds) return { ok: false, reason: 'timestamp outside tolerance' };
  }

  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);

  // Constant-time comparison against every candidate; several are valid while
  // a signing secret is mid-roll.
  let matched = false;
  for (const candidate of v1Signatures) {
    if (timingSafeEqual(expected, candidate)) matched = true;
  }
  if (!matched) return { ok: false, reason: 'signature mismatch' };

  return { ok: true };
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Compares without leaking where the first difference is via timing.
function timingSafeEqual(a, b) {
  const sa = String(a), sb = String(b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

function text(message, status) {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain' } });
}
