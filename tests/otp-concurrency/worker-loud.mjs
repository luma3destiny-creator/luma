// Same as worker.mjs but WITHOUT silencing the handlers, so the test can prove
// that nothing the code logs contains the OTP.
import { openD1 } from './d1.mjs';
import { onRequestPost as requestOtp } from '../../functions/api/request-otp.js';
const [, , file, op, phone, ip] = process.argv;
const { DB } = openD1(file);
const env = { DB, OTP_PEPPER: 'test-pepper', SMS_PROVIDER: 'mock',
  OTP_DAILY_SMS_CAP: process.env.CAP || '20',
  OTP_TEST_OUTBOX: process.env.OTP_TEST_OUTBOX || '',
  OTP_TEST_PHONES: process.env.OTP_TEST_PHONES || '' };
const res = await requestOtp({ request: {
  json: async () => ({ phone }), headers: { get: k => k === 'cf-connecting-ip' ? ip : null } }, env });
process.stdout.write(JSON.stringify({ status: res.status, body: await res.json() }));
