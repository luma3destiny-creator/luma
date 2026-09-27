import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openD1 } from './otp-concurrency/d1.mjs';
import { onRequestPost } from '../functions/api/sendmail.js';
import { randomToken, hash as sha256Hash, nowSeconds, SESSION_COOKIE } from '../functions/lib/member-session.mjs';

const alice = 'member-alice-0000001';
const bob = 'member-bob-00000002';

test('email authorization and atomic quota prevent unbounded provider calls', async () => {
  const { DB, raw } = openD1(':memory:');
  // owner_user_id (migrations/015_payments_owner.sql) must exist here too --
  // sendmail.js now gates through checkPaidAccess, which always selects it.
  // Every row below leaves it NULL (unowned), so token-only access keeps
  // working unchanged for everything this file already covered.
  raw.exec(`CREATE TABLE payments(id INTEGER PRIMARY KEY,token TEXT,status TEXT,expires_at TEXT,owner_user_id TEXT);
    INSERT INTO payments VALUES(1,'valid','paid',datetime('now','+1 day'),NULL);
    INSERT INTO payments VALUES(2,'expired','paid',datetime('now','-1 day'),NULL);
    INSERT INTO payments VALUES(3,'pending','pending',datetime('now','+1 day'),NULL);`);
  raw.exec(readFileSync(new URL('../migrations/008_email_send_attempts.sql', import.meta.url), 'utf8'));
  const original = globalThis.fetch;
  let sends = 0, fails = false;
  globalThis.fetch = async () => { sends++; if (fails) throw new Error('timeout'); return new Response('{}'); };
  const env = { DB, BREVO_API_KEY: 'mock-only' };
  const send = (token, extra = {}, config = env, cookie = '') => onRequestPost({ env: config, request: new Request('https://local/api/sendmail', { method: 'POST', headers: cookie ? { Cookie: cookie } : {}, body: JSON.stringify({ email: 'test@example.com', sections: [{ label: 'งาน', text: 'test' }], token, ...extra }) }) });
  try {
    for (const token of [undefined, 'dev', 'dev-token', 'invalid', 'expired', 'pending']) assert.ok((await send(token)).status >= 400);
    // A missing/placeholder token is now the same "no valid entitlement"
    // rejection checkPaidAccess gives everywhere else (402), not the
    // endpoint's own ad hoc 401.
    assert.equal((await send(undefined, { chargeId: 'pi_known' })).status, 402);
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

// ── owner-bound tokens: the same account/session gate every other paid
// endpoint enforces must also cover /api/sendmail -- a token that stopped
// working for AI calls must stop working for email too. ─────────────────────

function fixtureWithMembers(t) {
  const { DB, raw } = openD1(':memory:');
  t.after(() => raw.close());
  raw.exec(`CREATE TABLE payments(id INTEGER PRIMARY KEY,token TEXT,status TEXT,expires_at TEXT,owner_user_id TEXT)`);
  raw.exec(readFileSync(new URL('../migrations/008_email_send_attempts.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../migrations/011_membership_core.sql', import.meta.url), 'utf8'));
  raw.prepare('INSERT INTO users(id) VALUES (?), (?)').run(alice, bob);
  return { DB, raw };
}

async function signIn(raw, userId) {
  const token = randomToken();
  const now = nowSeconds();
  raw.prepare(`INSERT INTO member_sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(await sha256Hash(token), userId, now, now + 3600);
  return token;
}
function revoke(raw, token) {
  return sha256Hash(token).then(h =>
    raw.prepare(`UPDATE member_sessions SET revoked_at = ? WHERE token_hash = ?`).run(nowSeconds(), h)
  );
}
function cookieOf(token) { return `${SESSION_COOKIE}=${token}`; }

test('sendmail: A logs out -- A\'s own owner-bound token can no longer send email', async t => {
  const { DB, raw } = fixtureWithMembers(t);
  raw.prepare(`INSERT INTO payments(id, token, status, expires_at, owner_user_id) VALUES (1, 'tok-a', 'paid', datetime('now','+1 day'), ?)`).run(alice);
  const env = { DB, BREVO_API_KEY: 'mock-only' };
  const send = (token, cookie) => onRequestPost({ env, request: new Request('https://local/api/sendmail', {
    method: 'POST', headers: cookie ? { Cookie: cookie } : {},
    body: JSON.stringify({ email: 'test@example.com', sections: [{ label: 'งาน', text: 'test' }], token })
  }) });

  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}');
  t.after(() => { globalThis.fetch = original; });

  const aliceToken = await signIn(raw, alice);
  const before = await send('tok-a', cookieOf(aliceToken));
  assert.equal(before.status, 200, 'while signed in as the owner, sending must still work');

  await revoke(raw, aliceToken);
  const after = await send('tok-a', cookieOf(aliceToken));
  assert.equal(after.status, 401, 'the same token must be refused the moment the owning session is revoked (logout)');
});

test('sendmail: bob signed in can never send email with alice\'s owner-bound token', async t => {
  const { DB, raw } = fixtureWithMembers(t);
  raw.prepare(`INSERT INTO payments(id, token, status, expires_at, owner_user_id) VALUES (1, 'tok-a', 'paid', datetime('now','+1 day'), ?)`).run(alice);
  const env = { DB, BREVO_API_KEY: 'mock-only' };
  const send = (token, cookie) => onRequestPost({ env, request: new Request('https://local/api/sendmail', {
    method: 'POST', headers: cookie ? { Cookie: cookie } : {},
    body: JSON.stringify({ email: 'test@example.com', sections: [{ label: 'งาน', text: 'test' }], token })
  }) });

  const bobToken = await signIn(raw, bob);
  const result = await send('tok-a', cookieOf(bobToken));
  assert.equal(result.status, 401);

  const signedOut = await send('tok-a');
  assert.equal(signedOut.status, 401, 'signed out entirely, an owner-bound token must not work either');
});

test('sendmail: an unlinked (owner_user_id NULL) token keeps sending with no session at all', async t => {
  const { DB, raw } = fixtureWithMembers(t);
  raw.prepare(`INSERT INTO payments(id, token, status, expires_at, owner_user_id) VALUES (1, 'tok-legacy', 'paid', datetime('now','+1 day'), NULL)`).run();
  const env = { DB, BREVO_API_KEY: 'mock-only' };
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}');
  try {
    const result = await onRequestPost({ env, request: new Request('https://local/api/sendmail', {
      method: 'POST', body: JSON.stringify({ email: 'test@example.com', sections: [{ label: 'งาน', text: 'test' }], token: 'tok-legacy' })
    }) });
    assert.equal(result.status, 200);
  } finally { globalThis.fetch = original; }
});
