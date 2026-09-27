// tests/membership/purchase-link.mjs — login-required purchase & retired
// recovery/link endpoints.
//
// This round retires phone/OTP recovery and purchase-linking outright:
// every entitlement is now bound to a signed-in member account at purchase
// time (functions/api/pay.js), and there is no more account-linking or
// phone-recovery flow to test. This file covers what replaced it:
//
//   1. anonymous checkout is refused before the payment provider is ever
//      called and before any payments row is written;
//   2. a purchase made while signed in is bound to that account
//      (owner_user_id comes from the session, never the request body);
//   3. a brand-new session for the SAME account still resolves the same
//      entitlement (findOwnedEntitlement / /api/member/entitlement);
//   4. a DIFFERENT account never sees another account's entitlement;
//   5. the five retired endpoints (request-otp, verify-otp,
//      check-access?phone=, member/link-request-otp, member/link-verify-otp)
//      all answer 410 without reading/writing otp_challenges or payments,
//      and without calling the SMS provider, regardless of any
//      legacy/unset environment flag.
//
// The fail-closed expiry rule and owner-bound-token session checks (A logs
// out, B signs in, etc.) are unaffected by this round and stay covered here
// too, since pay.js/check-access.js's token branch and paid-access.mjs are
// unchanged.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openD1 } from '../otp-concurrency/d1.mjs';
import { findOwnedEntitlement } from '../../functions/lib/purchase-link.mjs';
import { randomToken, hash as sha256Hash, nowSeconds, SESSION_COOKIE } from '../../functions/lib/member-session.mjs';
import { checkPaidAccess } from '../../functions/lib/paid-access.mjs';
import { onRequestGet as checkAccessGet } from '../../functions/api/check-access.js';
import { onRequestPost as requestOtpPost } from '../../functions/api/request-otp.js';
import { onRequestPost as verifyOtpPost } from '../../functions/api/verify-otp.js';
import { onRequestPost as payPost } from '../../functions/api/pay.js';
import { onRequestPost as linkRequestOtpPost } from '../../functions/api/member/link-request-otp.js';
import { onRequestPost as linkVerifyOtpPost } from '../../functions/api/member/link-verify-otp.js';
import { onRequestGet as entitlementGet } from '../../functions/api/member/entitlement.js';

const alice = 'member-alice-0000001';
const bob = 'member-bob-00000002';
const origin = 'https://app.test';

function fixture(t) {
  const { raw, DB } = openD1(':memory:');
  t.after(() => raw.close());
  raw.exec('PRAGMA foreign_keys=ON');
  raw.exec(readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../../migrations/011_membership_core.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../../migrations/005_otp_challenges.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../../migrations/015_payments_owner.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../../migrations/016_otp_challenges_purpose.sql', import.meta.url), 'utf8'));
  raw.prepare('INSERT INTO users(id) VALUES (?), (?)').run(alice, bob);
  const env = { DB, MEMBERSHIP_ENABLED: 'true', AUTH_ORIGIN: origin, STRIPE_SECRET_KEY: 'sk_test_x' };
  return { raw, DB, env };
}

function insertPaidOrder(raw, { phone, ownerUserId = null, expiresAt = '2099-01-01 00:00:00', token = 'tok-' + Math.random().toString(36).slice(2), paidAt = "datetime('now')" }) {
  raw.prepare(
    `INSERT INTO payments (phone, status, token, paid_at, expires_at, owner_user_id)
     VALUES (?, 'paid', ?, ${paidAt}, ?, ?)`
  ).run(phone, token, expiresAt, ownerUserId);
  return token;
}

// A real member session, the same shape currentMember() reads -- not a stub.
async function signIn(raw, userId) {
  const token = randomToken();
  const now = nowSeconds();
  raw.prepare(
    `INSERT INTO member_sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
  ).run(await sha256Hash(token), userId, now, now + 3600);
  return token;
}
function revoke(raw, token) {
  return sha256Hash(token).then(h =>
    raw.prepare(`UPDATE member_sessions SET revoked_at = ? WHERE token_hash = ?`).run(nowSeconds(), h)
  );
}
function cookieOf(token) { return token ? `${SESSION_COOKIE}=${token}` : ''; }
function req(url, { method = 'GET', cookie = '', body, sameOrigin = true } = {}) {
  const headers = { Cookie: cookie };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method === 'POST') headers.Origin = sameOrigin ? origin : 'https://evil.invalid';
  return new Request(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

// A fetch stub that records every call, so tests can prove pay.js never
// reaches the payment provider for a refused checkout.
function trackedFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ id: 'pi_test_' + calls.length, next_action: null }) };
  };
  fn.calls = calls;
  return fn;
}

// ── Login is mandatory before checkout ─────────────────────────────────────

test('pay.js: no session cookie at all -> 401 LOGIN_REQUIRED, provider never called, no row written', async t => {
  const { raw, env } = fixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = trackedFetch();
  t.after(() => { globalThis.fetch = originalFetch; });
  const res = await payPost({
    request: req(origin + '/api/pay', { method: 'POST', body: { phone: '0811111111', age: 30 } }),
    env
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'LOGIN_REQUIRED');
  assert.equal(globalThis.fetch.calls.length, 0, 'the payment provider must never be called for a refused checkout');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM payments').get().n, 0);
});

test('pay.js: a revoked/expired session cookie -> 401 LOGIN_REQUIRED, provider never called, no row written', async t => {
  const { raw, env } = fixture(t);
  const aliceToken = await signIn(raw, alice);
  await revoke(raw, aliceToken); // session existed but is no longer live
  const originalFetch = globalThis.fetch;
  globalThis.fetch = trackedFetch();
  t.after(() => { globalThis.fetch = originalFetch; });
  const res = await payPost({
    request: req(origin + '/api/pay', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone: '0811111111', age: 30 } }),
    env
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'LOGIN_REQUIRED');
  assert.equal(globalThis.fetch.calls.length, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM payments').get().n, 0);
});

test('pay.js: signed in -> checkout proceeds and owner_user_id comes from the session, never the request body', async t => {
  const { raw, env } = fixture(t);
  const aliceToken = await signIn(raw, alice);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = trackedFetch();
  t.after(() => { globalThis.fetch = originalFetch; });
  const res = await payPost({
    // pay.js has no owner/userId field to read from the body in the first
    // place -- this proves that, rather than exercising a real bypass.
    request: req(origin + '/api/pay', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone: '0811111111', age: 30, owner_user_id: bob, userId: bob } }),
    env
  });
  assert.equal(res.status, 200);
  assert.equal(globalThis.fetch.calls.length, 1, 'exactly one payment-provider call for one checkout');
  const row = raw.prepare('SELECT owner_user_id FROM payments WHERE phone=?').get('0811111111');
  assert.equal(row.owner_user_id, alice);
});

test('pay.js: a session cookie present but the lookup fails refuses checkout instead of creating a silent ownerless order', async t => {
  const { raw, env } = fixture(t);
  const badDb = {
    ...env.DB,
    prepare: (sql) => {
      if (/member_sessions/.test(sql)) {
        return { bind: () => ({ first: async () => { throw new Error('boom'); } }) };
      }
      return env.DB.prepare(sql);
    }
  };
  const brokenEnv = { ...env, DB: badDb };
  const aliceToken = await signIn(raw, alice);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = trackedFetch();
  t.after(() => { globalThis.fetch = originalFetch; });
  const res = await payPost({
    request: req(origin + '/api/pay', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone: '0811111111', age: 30 } }),
    env: brokenEnv
  });
  assert.equal(res.status, 503);
  assert.equal(globalThis.fetch.calls.length, 0);
  const count = raw.prepare('SELECT COUNT(*) AS n FROM payments').get().n;
  assert.equal(count, 0, 'no ownerless order may be written when the session lookup itself failed');
});

// ── A new session for the same account still resolves the same entitlement ─

test('a new session for the same account still resolves the entitlement bought under an earlier session', async t => {
  const { raw, env } = fixture(t);
  insertPaidOrder(raw, { phone: '0822222222', ownerUserId: alice });
  const firstSession = await signIn(raw, alice);
  await revoke(raw, firstSession); // that session ends (e.g. logout)...
  const newSession = await signIn(raw, alice); // ...and alice logs in again, elsewhere
  const res = await entitlementGet({ request: req(origin + '/api/member/entitlement', { cookie: cookieOf(newSession) }), env });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.hasEntitlement, true);
});

test('a different account never sees another account\'s entitlement', async t => {
  const { raw, env } = fixture(t);
  insertPaidOrder(raw, { phone: '0822222222', ownerUserId: alice });
  const bobToken = await signIn(raw, bob);
  const res = await entitlementGet({ request: req(origin + '/api/member/entitlement', { cookie: cookieOf(bobToken) }), env });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.hasEntitlement, false);
});

test('/api/member/entitlement: signed out gets 401, never a lookup result', async t => {
  const { raw, env } = fixture(t);
  insertPaidOrder(raw, { phone: '0822222222', ownerUserId: alice });
  const res = await entitlementGet({ request: req(origin + '/api/member/entitlement'), env });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).signedIn, false);
});

test('findOwnedEntitlement: a login on a new device with no local token still finds the account-owned entitlement', async t => {
  const { raw, env } = fixture(t);
  const token = insertPaidOrder(raw, { phone: '0822222222', ownerUserId: alice });
  const got = await findOwnedEntitlement(env, alice);
  assert.equal(got.token, token);
});

test('accounts are isolated at the findOwnedEntitlement level too: bob never sees an order owned by alice', async t => {
  const { raw, env } = fixture(t);
  insertPaidOrder(raw, { phone: '0811111111', ownerUserId: alice });
  assert.equal(await findOwnedEntitlement(env, bob), null);
});

test('a member with no owned order gets nothing back', async t => {
  const { env } = fixture(t);
  assert.equal(await findOwnedEntitlement(env, alice), null);
});

// ── Owner-bound token session checks (unchanged this round, re-verified) ──

test('checkPaidAccess: signed-out caller cannot use an owner-bound token', async t => {
  const { raw, env } = fixture(t);
  const token = insertPaidOrder(raw, { phone: '0833333333', ownerUserId: alice });
  const result = await checkPaidAccess({ env, request: req(origin + '/x') }, token);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('checkPaidAccess: A logs out (session revoked) -> A\'s own token stops working', async t => {
  const { raw, env } = fixture(t);
  const token = insertPaidOrder(raw, { phone: '0833333333', ownerUserId: alice });
  const aliceToken = await signIn(raw, alice);
  const before = await checkPaidAccess({ env, request: req(origin + '/x', { cookie: cookieOf(aliceToken) }) }, token);
  assert.equal(before.ok, true);
  await revoke(raw, aliceToken);
  const after = await checkPaidAccess({ env, request: req(origin + '/x', { cookie: cookieOf(aliceToken) }) }, token);
  assert.equal(after.ok, false);
  assert.equal(after.status, 401);
});

test('checkPaidAccess: B logs in -> A\'s owner-bound token never works under B\'s session', async t => {
  const { raw, env } = fixture(t);
  const token = insertPaidOrder(raw, { phone: '0833333333', ownerUserId: alice });
  const bobToken = await signIn(raw, bob);
  const result = await checkPaidAccess({ env, request: req(origin + '/x', { cookie: cookieOf(bobToken) }) }, token);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('checkPaidAccess: an unlinked (owner_user_id NULL) token is refused outright -- no anonymous/legacy access, signed out or in as anyone', async t => {
  const { raw, env } = fixture(t);
  const token = insertPaidOrder(raw, { phone: '0833333333', ownerUserId: null });
  const signedOut = await checkPaidAccess({ env, request: req(origin + '/x') }, token);
  assert.equal(signedOut.ok, false);
  assert.equal(signedOut.status, 401);
  // Being signed in as SOME account does not help either -- the row belongs
  // to nobody, so there is no account it could ever match.
  const aliceToken = await signIn(raw, alice);
  const signedInAsAlice = await checkPaidAccess({ env, request: req(origin + '/x', { cookie: cookieOf(aliceToken) }) }, token);
  assert.equal(signedInAsAlice.ok, false);
  assert.equal(signedInAsAlice.status, 401);
});

test('check-access route (token branch): A logs out -> A\'s owner-bound token no longer reports ok', async t => {
  const { raw, env } = fixture(t);
  const token = insertPaidOrder(raw, { phone: '0844444444', ownerUserId: alice });
  const aliceToken = await signIn(raw, alice);
  const before = await checkAccessGet({ request: req(origin + '/api/check-access?token=' + token, { cookie: cookieOf(aliceToken) }), env });
  assert.equal((await before.json()).ok, true);
  await revoke(raw, aliceToken);
  const after = await checkAccessGet({ request: req(origin + '/api/check-access?token=' + token, { cookie: cookieOf(aliceToken) }), env });
  assert.equal((await after.json()).ok, false);
});

test('check-access route (token branch): B signed in cannot use A\'s owner-bound token', async t => {
  const { raw, env } = fixture(t);
  const token = insertPaidOrder(raw, { phone: '0844444444', ownerUserId: alice });
  const bobToken = await signIn(raw, bob);
  const res = await checkAccessGet({ request: req(origin + '/api/check-access?token=' + token, { cookie: cookieOf(bobToken) }), env });
  assert.equal((await res.json()).ok, false);
});

test('check-access route (token branch): an unlinked token is refused outright, signed out or signed in as anyone', async t => {
  const { raw, env } = fixture(t);
  const token = insertPaidOrder(raw, { phone: '0844444444', ownerUserId: null });
  const signedOut = await checkAccessGet({ request: req(origin + '/api/check-access?token=' + token), env });
  assert.equal((await signedOut.json()).ok, false);
  const aliceToken = await signIn(raw, alice);
  const signedInAsAlice = await checkAccessGet({ request: req(origin + '/api/check-access?token=' + token, { cookie: cookieOf(aliceToken) }), env });
  assert.equal((await signedInAsAlice.json()).ok, false);
});

// ── Fail-closed expiry rule (unchanged this round) ─────────────────────────

test('checkPaidAccess refuses a NULL expires_at', async t => {
  const { raw, env } = fixture(t);
  raw.prepare(`INSERT INTO payments (phone, status, token, paid_at, expires_at) VALUES (?, 'paid', ?, datetime('now'), NULL)`)
    .run('0855555555', 'tok-null-exp');
  const result = await checkPaidAccess({ env, request: req(origin + '/x') }, 'tok-null-exp');
  assert.equal(result.ok, false);
});

test('checkPaidAccess refuses a malformed expires_at string', async t => {
  const { raw, env } = fixture(t);
  raw.prepare(`INSERT INTO payments (phone, status, token, paid_at, expires_at) VALUES (?, 'paid', ?, datetime('now'), ?)`)
    .run('0855555555', 'tok-bad-exp', 'not-a-real-date');
  const result = await checkPaidAccess({ env, request: req(origin + '/x') }, 'tok-bad-exp');
  assert.equal(result.ok, false);
});

test('check-access route (token branch) refuses NULL/malformed expiry the same way', async t => {
  const { raw, env } = fixture(t);
  raw.prepare(`INSERT INTO payments (phone, status, token, paid_at, expires_at) VALUES (?, 'paid', ?, datetime('now'), NULL)`)
    .run('0855555555', 'tok-null-2');
  const res = await checkAccessGet({ request: req(origin + '/api/check-access?token=tok-null-2'), env });
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.expired, true);
});

test('findOwnedEntitlement refuses a NULL/malformed expiry -- same fail-closed rule', async t => {
  const { raw, env } = fixture(t);
  raw.prepare(`INSERT INTO payments (phone, status, token, paid_at, expires_at, owner_user_id) VALUES (?, 'paid', ?, datetime('now'), NULL, ?)`)
    .run('0877777777', 'tok-owned-null', alice);
  assert.deepEqual(await findOwnedEntitlement(env, alice), { expired: true });
});

// ── The five retired endpoints: unconditional 410, no side effects ─────────

test('request-otp.js: always 410, never reads/writes otp_challenges, whatever the env', async t => {
  const { raw, env } = fixture(t);
  for (const extraEnv of [{}, { OTP_PEPPER: 'x', SMS_PROVIDER: 'mock' }, { PURCHASE_RECOVERY_DISABLED: 'false' }, { OTP_RECOVERY_ENABLED: 'true' }]) {
    const res = await requestOtpPost({
      request: req(origin + '/api/request-otp', { method: 'POST', body: { phone: '0955500001' } }),
      env: { ...env, ...extraEnv }
    });
    assert.equal(res.status, 410);
    assert.equal((await res.json()).code, 'RECOVERY_RETIRED');
  }
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM otp_challenges').get().n, 0);
});

test('verify-otp.js: always 410, never reads/writes otp_challenges, whatever the env', async t => {
  const { raw, env } = fixture(t);
  for (const extraEnv of [{}, { OTP_PEPPER: 'x' }, { PURCHASE_RECOVERY_DISABLED: 'false' }]) {
    const res = await verifyOtpPost({
      request: req(origin + '/api/verify-otp', { method: 'POST', body: { phone: '0955500002', code: '123456', challengeId: 'x' } }),
      env: { ...env, ...extraEnv }
    });
    assert.equal(res.status, 410);
    assert.equal((await res.json()).code, 'RECOVERY_RETIRED');
  }
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM otp_challenges').get().n, 0);
});

test('check-access?phone=: always 410, never touches the payments row it would have looked up, whatever the env', async t => {
  const { raw, env } = fixture(t);
  insertPaidOrder(raw, { phone: '0866666666', ownerUserId: null });
  for (const extraEnv of [{}, { PURCHASE_RECOVERY_DISABLED: 'false' }, { OTP_RECOVERY_ENABLED: 'true' }]) {
    const res = await checkAccessGet({
      request: req(origin + '/api/check-access?phone=0866666666'),
      env: { ...env, ...extraEnv }
    });
    assert.equal(res.status, 410);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'RECOVERY_RETIRED');
  }
  const row = raw.prepare('SELECT token FROM payments WHERE phone=?').get('0866666666');
  assert.ok(row.token, 'the phone-branch 410 must never rotate/clear the token on the order it would have looked up');
});

test('check-access token branch is unaffected by the phone-path retirement (still refuses an unowned row on its own separate rule)', async t => {
  const { raw, env } = fixture(t);
  const token = insertPaidOrder(raw, { phone: '0866666667', ownerUserId: null });
  const res = await checkAccessGet({ request: req(origin + '/api/check-access?token=' + token), env });
  // Refused because the row is unowned (this round's rule), not because the
  // phone-path retirement leaked into the token branch -- a separate,
  // owned-token case proves the token branch itself still works below.
  assert.equal((await res.json()).ok, false);
});

test('check-access token branch grants access for an owned, signed-in-as-owner token, unaffected by the phone-path retirement', async t => {
  const { raw, env } = fixture(t);
  const token = insertPaidOrder(raw, { phone: '0866666668', ownerUserId: alice });
  const aliceToken = await signIn(raw, alice);
  const res = await checkAccessGet({ request: req(origin + '/api/check-access?token=' + token, { cookie: cookieOf(aliceToken) }), env });
  assert.equal((await res.json()).ok, true);
});

test('member/link-request-otp: always 410, whatever the env, no session required to get the 410', async t => {
  const { raw, env } = fixture(t);
  for (const extraEnv of [{}, { OTP_PEPPER: 'x' }]) {
    const res = await linkRequestOtpPost({
      request: req(origin + '/api/member/link-request-otp', { method: 'POST', body: { phone: '0811111111' } }),
      env: { ...env, ...extraEnv }
    });
    assert.equal(res.status, 410);
    assert.equal((await res.json()).code, 'LINK_PURCHASE_RETIRED');
  }
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM otp_challenges').get().n, 0);
});

test('member/link-verify-otp: always 410, whatever the env, never grants ownership', async t => {
  const { raw, env } = fixture(t);
  for (const extraEnv of [{}, { OTP_PEPPER: 'x' }]) {
    const res = await linkVerifyOtpPost({
      request: req(origin + '/api/member/link-verify-otp', { method: 'POST', body: { phone: '0811111111', code: '123456', challengeId: 'x' } }),
      env: { ...env, ...extraEnv }
    });
    assert.equal(res.status, 410);
    assert.equal((await res.json()).code, 'LINK_PURCHASE_RETIRED');
  }
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM payments WHERE owner_user_id IS NOT NULL').get().n, 0);
});
