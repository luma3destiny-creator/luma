// One operation, in its own OS process, against the shared SQLite file.
import { openD1 } from './d1.mjs';
import { onRequestPost as requestOtp } from '../../functions/api/request-otp.js';
import { onRequestPost as verifyOtp }  from '../../functions/api/verify-otp.js';
import { onRequestGet as checkAccess }  from '../../functions/api/check-access.js';
import { onRequestPost as stripeWebhook } from '../../functions/api/stripe-webhook.js';
import { hashPhone, hashCode, consumeChallengeByPublicId, applyTokenToOrder } from '../../functions/lib/otp.mjs';

const [, , file, op, ...rest] = process.argv;
const { DB } = openD1(file);
// A provider that never gets a reply. No network is touched: the stub throws
// before any request leaves, which is exactly the case we must record as
// 'unknown' rather than 'failed' — the message may have gone out and be billed.
if (process.env.SIMULATE_TIMEOUT === 'true') {
  globalThis.fetch = async () => { throw new Error('simulated timeout'); };
}

const env = {
  DB, OTP_PEPPER: 'test-pepper',
  SMS_PROVIDER: process.env.SMS_PROVIDER || 'mock',
  BREVO_API_KEY: process.env.BREVO_API_KEY || '',
  SMS_SENDER_ID: process.env.SMS_SENDER_ID || '',
  OTP_DAILY_SMS_CAP: process.env.CAP || '20',
  OTP_TEST_OUTBOX: process.env.OTP_TEST_OUTBOX || '',
  OTP_TEST_PHONES: process.env.OTP_TEST_PHONES || ''
};
const WEBHOOK_SECRET = 'whsec_test_secret';

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Make the database fail at one exact point, so the handler meets the failure
 * it is supposed to survive rather than a description of one.
 *   FAIL_AT=grant        -> the UPDATE that marks the order paid throws
 *   FAIL_AT=record_event -> the worker dies AFTER granting, before the event row
 */
function withFault(DB, failAt) {
  if (!failAt) return DB;
  return {
    prepare(sql) {
      const isGrant = /UPDATE payments/i.test(sql) && /status\s*=\s*'paid'/i.test(sql);
      const isRecord = /INSERT OR IGNORE INTO webhook_events/i.test(sql);
      if ((failAt === 'grant' && isGrant) || (failAt === 'record_event' && isRecord)) {
        const boom = () => { throw new Error('simulated database failure'); };
        return { bind: () => ({ run: boom, first: boom }), run: boom, first: boom };
      }
      return DB.prepare(sql);
    }
  };
}

const req = (body, ip) => ({
  json: async () => body,
  headers: { get: (k) => (k === 'cf-connecting-ip' ? ip : null) }
});

// quiet: the handlers log, and 30 processes of log noise hides the result
console.log = () => {}; console.error = () => {};

let out;
try {
  if (op === 'request') {
    const [phone, ip] = rest;
    const res = await requestOtp({ request: req({ phone }, ip), env });
    out = { status: res.status, body: await res.json() };
  } else if (op === 'verify') {
    const [phone, code, challengeId] = rest;
    const res = await verifyOtp({ request: req({ phone, code, challengeId }), env });
    out = { status: res.status, body: await res.json() };
  } else if (op === 'check-access') {
    const [token] = rest;
    const res = await checkAccess({
      request: { url: 'https://example.test/api/check-access?token=' + encodeURIComponent(token) },
      env
    });
    out = { status: res.status, body: await res.json() };
  } else if (op === 'apply-stalled') {
    // A request that consumed its code and then STALLED, resuming at the exact
    // moment it would write the token. Nothing about elapsed time is involved:
    // this is the write step itself, arriving late.
    const [publicId, orderId, token] = rest;
    out = await applyTokenToOrder(env, { publicId, orderId: Number(orderId), token });
  } else if (op === 'webhook') {
    // chargeId, eventId, [amount], [createdOffsetSeconds]
    const [chargeId, eventId, amountArg, offsetArg] = rest;
    const created = Math.floor(Date.now() / 1000) - (Number(offsetArg) || 0);
    const event = {
      id: eventId,
      type: 'payment_intent.succeeded',
      created,
      data: { object: {
        id: chargeId, status: 'succeeded',
        amount: Number(amountArg || 5900), currency: 'thb'
      } }
    };
    const rawBody = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = 't=' + t + ',v1=' + await hmacHex(WEBHOOK_SECRET, t + '.' + rawBody);
    const res = await stripeWebhook({
      request: { text: async () => rawBody, headers: { get: (k) => (k.toLowerCase() === 'stripe-signature' ? sig : null) } },
      env: { ...env, DB: withFault(DB, process.env.FAIL_AT), STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET }
    });
    out = { status: res.status, body: await res.text() };
  } else if (op === 'verify-crash') {
    // Accept the code, reserve the token... then die before touching `payments`.
    const [phone, code, challengeId] = rest;
    const e164 = '66' + phone.slice(1);
    const r = await consumeChallengeByPublicId(env, {
      publicId: challengeId,
      codeHash: await hashCode(env.OTP_PEPPER, e164, code),
      candidateToken: 'tok-from-crashed-run'
    });
    out = { crashedAfter: r };
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }));
  process.exit(1);
}
