import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openD1 } from './otp-concurrency/d1.mjs';
import { onRequestPost } from '../functions/api/sendmail.js';

test('email authorization and atomic quota prevent unbounded provider calls', async () => {
  const { DB, raw } = openD1(':memory:');
  raw.exec(`CREATE TABLE payments(id INTEGER PRIMARY KEY,token TEXT,status TEXT,expires_at TEXT);
    INSERT INTO payments VALUES(1,'valid','paid',datetime('now','+1 day'));
    INSERT INTO payments VALUES(2,'expired','paid',datetime('now','-1 day'));
    INSERT INTO payments VALUES(3,'pending','pending',datetime('now','+1 day'));`);
  raw.exec(readFileSync(new URL('../migrations/008_email_send_attempts.sql', import.meta.url), 'utf8'));
  const original = globalThis.fetch;
  let sends = 0, fails = false;
  globalThis.fetch = async () => { sends++; if (fails) throw new Error('timeout'); return new Response('{}'); };
  const env = { DB, BREVO_API_KEY: 'mock-only' };
  const send = (token, extra = {}, config = env) => onRequestPost({ env: config, request: new Request('https://local/api/sendmail', { method: 'POST', body: JSON.stringify({ email: 'test@example.com', sections: [{ label: 'งาน', text: 'test' }], token, ...extra }) }) });
  try {
    for (const token of [undefined, 'dev', 'dev-token', 'invalid', 'expired', 'pending']) assert.ok((await send(token)).status >= 400);
    assert.equal((await send(undefined, { chargeId: 'pi_known' })).status, 401);
    assert.equal(sends, 0);
    const burst = await Promise.all(Array.from({ length: 10 }, () => send('valid')));
    assert.equal(burst.filter(r => r.status === 200).length, 1);
    assert.equal(sends, 1);
    raw.exec("UPDATE payments SET token='rotated' WHERE id=1");
    assert.equal((await send('rotated')).status, 429);
    for (let i = 0; i < 2; i++) {
      raw.exec("UPDATE email_send_attempts SET created_at=datetime('now','-2 minutes')");
      assert.equal((await send('rotated')).status, 200);
    }
    raw.exec("UPDATE email_send_attempts SET created_at=datetime('now','-2 minutes')");
    assert.equal((await send('rotated')).status, 429);
    assert.equal(sends, 3);
    raw.exec("UPDATE email_send_attempts SET created_at=datetime('now','-25 hours')");
    fails = true;
    assert.equal((await send('rotated')).status, 502);
    assert.equal((await send('rotated')).status, 429);
    assert.equal(sends, 4);
    raw.exec("UPDATE email_send_attempts SET created_at=datetime('now','-25 hours')");
    raw.exec("INSERT INTO email_send_attempts(payment_id) SELECT 99 FROM json_each('[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]')");
    assert.equal((await send('rotated')).status, 429);
    assert.equal((await send('rotated', { sections: [] })).status, 400);
    assert.equal((await send('rotated', { overview: 'x'.repeat(70000) })).status, 413);
    assert.equal(sends, 4);
    assert.equal((await send('rotated', {}, { BREVO_API_KEY: 'mock' })).status, 503);
    raw.exec('DROP TABLE email_send_attempts');
    assert.equal((await send('rotated')).status, 503);
    assert.equal(sends, 4);
  } finally { globalThis.fetch = original; raw.close(); }
});
