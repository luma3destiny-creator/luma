// One operation, in its own OS process, against the shared SQLite file.
import { openD1 } from './d1.mjs';
import { onRequestPost as requestOtp } from '../../functions/api/request-otp.js';
import { onRequestPost as verifyOtp }  from '../../functions/api/verify-otp.js';
import { onRequestGet as checkAccess }  from '../../functions/api/check-access.js';
import { hashPhone, hashCode, consumeChallengeByPublicId } from '../../functions/lib/otp.mjs';

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
