import test from 'node:test';
import assert from 'node:assert/strict';
import { sendSms } from '../functions/lib/sms.mjs';

const env = { SMS_PROVIDER: 'thsms', THSMS_API_KEY: 'test-key-not-real', SMS_SENDER_ID: 'SMSOTP' };
const message = { to: '+66900000000', text: 'LUMA test code 123456' };

test('THSMS V2 adapter: all network calls are stubbed', async t => {
  let calls = [];
  let response;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (response instanceof Error) throw response;
    return response;
  });

  await t.test('documented request and acceptance without a message ID', async () => {
    response = Response.json({ success: true, code: 200, data: { credit_usage: 1, remaining_credit: 9 } });
    assert.deepEqual(await sendSms(env, message), { ok: true, status: 'sent', provider: 'thsms' });
    const { url, options } = calls.at(-1);
    assert.equal(url, 'https://thsms.com/api/send-sms');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer test-key-not-real');
    assert.deepEqual(JSON.parse(options.body), { msisdn: ['0900000000'], message: message.text, sender: 'SMSOTP' });
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
  });

  for (const [label, status, body, expected] of [
    ['HTTP rejection', 401, { success: false, code: 401 }, 'failed'],
    ['application rejection with HTTP 200', 200, { success: false, code: 400 }, 'failed'],
    ['ambiguous server error', 503, { success: false }, 'unknown'],
    ['server timeout', 408, {}, 'unknown'],
    ['missing confirmation', 200, {}, 'unknown'],
    ['contradictory confirmation', 200, { success: true, code: 400 }, 'unknown'],
    ['invalid JSON', 200, 'not JSON', 'unknown'],
  ]) {
    await t.test(label, async () => {
      response = typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status });
      const before = calls.length;
      const result = await sendSms(env, message);
      assert.equal(result.ok, false);
      assert.equal(result.status, expected);
      assert.equal(calls.length - before, 1, 'no retry');
      assert.equal(JSON.stringify(result).includes(message.text), false);
    });
  }

  await t.test('network/timeout uncertainty never retries', async () => {
    response = new DOMException('Timed out', 'TimeoutError');
    const before = calls.length;
    assert.equal((await sendSms(env, message)).status, 'unknown');
    assert.equal(calls.length - before, 1);
  });

  await t.test('redirects never forward credentials or retry', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      response = new Response(null, { status, headers: { Location: 'https://example.invalid/collect' } });
      const before = calls.length;
      const result = await sendSms(env, message);
      assert.equal(result.reason, 'unexpected_redirect');
      assert.equal(result.status, 'unknown');
      assert.equal(calls.length - before, 1);
      assert.equal(calls.at(-1).options.redirect, 'manual');
    }
  });

  await t.test('diagnostics never expose exception text or secrets', async () => {
    const logs = [];
    const logger = t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
    try {
      for (const [name, expected] of [
        ['TimeoutError', 'request_timeout'], ['AbortError', 'request_aborted'],
        ['TypeError', 'request_type_error'], ['Error', 'network_error']
      ]) {
        response = new Error(env.THSMS_API_KEY + message.to + message.text);
        response.name = name;
        const result = await sendSms(env, message);
        assert.equal(result.reason, expected);
        assert.equal(result.status, 'unknown');
        const output = JSON.stringify({ result, logs });
        for (const secret of [env.THSMS_API_KEY, message.to, message.text]) {
          assert.equal(output.includes(secret), false);
        }
      }
    } finally { logger.mock.restore(); }
  });

  await t.test('missing configuration and malformed recipient send nothing', async () => {
    const before = calls.length;
    assert.equal((await sendSms({ ...env, THSMS_API_KEY: '' }, message)).reason, 'no_api_key');
    assert.equal((await sendSms({ ...env, SMS_SENDER_ID: '' }, message)).reason, 'no_sender_id');
    assert.equal((await sendSms(env, { ...message, to: 'bad' })).reason, 'invalid_recipient');
    assert.equal(calls.length, before);
  });
});
