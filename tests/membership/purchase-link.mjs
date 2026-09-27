// tests/membership/purchase-link.mjs — owner-bound access control, OTP
// purpose/account/order binding, and the fail-closed expiry rule, exercised
// through the REAL exported route handlers wherever the scenario involves an
// API route (never re-implemented against functions/lib/*.mjs alone).
//
// Covers this round's checklist:
//   1. owner_user_id enforcement on every paid-access route: A's token stops
//      working the moment A logs out, and never works signed in as B; a
//      still-unlinked (owner_user_id NULL) row keeps working on token alone.
//   2. (browser-side token clearing is covered by app.html/member.html
//      themselves -- nothing to exercise here; the routes below are what
//      actually enforces access regardless of what the browser is holding.)
//   3. OTP purpose/account/order binding: a recovery code cannot link an
//      account and a link code cannot recover access; a link challenge can
//      only be confirmed by the account that requested it, and only ever
//      links the ONE order it was bound to at request time -- never a fresh
//      "latest unlinked" pick, even when a second order exists or arrives.
//   4. the one fail-closed expiry rule (null/malformed/expired -> no access)
//      on every route that grants access, and pay.js refusing to create a
//      silent ownerless order when a session lookup genuinely fails.
//   5. crash-safety: a retry after consumeChallengeByPublicId succeeded but
//      applyOwnerToOrder never ran completes the link exactly once.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openD1 } from '../otp-concurrency/d1.mjs';
import {
  findOwnedEntitlement, requestLinkOtp, confirmLinkOtp
} from '../../functions/lib/purchase-link.mjs';
import {
  hashCode, hashPhone, toE164Thai, consumeChallengeByPublicId, applyOwnerToOrder
} from '../../functions/lib/otp.mjs';
import { randomToken, hash as sha256Hash, nowSeconds, SESSION_COOKIE } from '../../functions/lib/member-session.mjs';
import { checkPaidAccess } from '../../functions/lib/paid-access.mjs';
import { onRequestGet as recoveryModeGet } from '../../functions/api/recovery-mode.js';
import { onRequestGet as checkAccessGet } from '../../functions/api/check-access.js';
import { onRequestPost as requestOtpPost } from '../../functions/api/request-otp.js';
import { onRequestPost as verifyOtpPost } from '../../functions/api/verify-otp.js';
import { onRequestPost as payPost } from '../../functions/api/pay.js';
import { onRequestPost as linkRequestOtpPost } from '../../functions/api/member/link-request-otp.js';
import { onRequestPost as linkVerifyOtpPost } from '../../functions/api/member/link-verify-otp.js';
import { onRequestGet as entitlementGet } from '../../functions/api/member/entitlement.js';

const alice = 'member-alice-0000001';
const bob = 'member-bob-00000002';
const pepper = 'test-only-pepper';
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
  const env = { DB, OTP_PEPPER: pepper, SMS_PROVIDER: 'mock', MEMBERSHIP_ENABLED: 'true', AUTH_ORIGIN: origin };
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

// ── findOwnedEntitlement: the "log in on a new device" path ───────────────

test('a member with no owned order gets nothing back', async t => {
  const { env } = fixture(t);
  assert.equal(await findOwnedEntitlement(env, alice), null);
});

test('a member sees their own paid, unexpired order by account -- not by phone or token', async t => {
  const { raw, env } = fixture(t);
  const token = insertPaidOrder(raw, { phone: '0811111111', ownerUserId: alice });
  const got = await findOwnedEntitlement(env, alice);
  assert.deepEqual(got, { token, expiresAt: '2099-01-01 00:00:00' });
});

test('accounts are isolated: bob never sees an order owned by alice', async t => {
  const { raw, env } = fixture(t);
  insertPaidOrder(raw, { phone: '0811111111', ownerUserId: alice });
  assert.equal(await findOwnedEntitlement(env, bob), null);
});

test('an owned order that has expired is reported as expired, not handed back', async t => {
  const { raw, env } = fixture(t);
  insertPaidOrder(raw, { phone: '0811111111', ownerUserId: alice, expiresAt: '2000-01-01 00:00:00' });
  assert.deepEqual(await findOwnedEntitlement(env, alice), { expired: true });
});

test('a login on a new device (no local token) still finds the account-owned entitlement', async t => {
  const { raw, env } = fixture(t);
  const token = insertPaidOrder(raw, { phone: '0822222222', ownerUserId: alice });
  const got = await findOwnedEntitlement(env, alice);
  assert.equal(got.token, token);
});

test('/api/member/entitlement: signed out gets 401, never a lookup result', async t => {
  const { raw, env } = fixture(t);
  insertPaidOrder(raw, { phone: '0822222222', ownerUserId: alice });
  const res = await entitlementGet({ request: req(origin + '/api/member/entitlement'), env });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).signedIn, false);
});

test('/api/member/entitlement: bob signed in never sees an order owned by alice', async t => {
  const { raw, env } = fixture(t);
  insertPaidOrder(raw, { phone: '0822222222', ownerUserId: alice });
  const bobToken = await signIn(raw, bob);
  const res = await entitlementGet({ request: req(origin + '/api/member/entitlement', { cookie: cookieOf(bobToken) }), env });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.hasEntitlement, false);
});

// ── Scenario 1 & 5a/b: A logs out -> B logs in; A's token never works for B ─

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
  // Confirm it works while signed in...
  const before = await checkPaidAccess({ env, request: req(origin + '/x', { cookie: cookieOf(aliceToken) }) }, token);
  assert.equal(before.ok, true);
  // ...then log out (revoke the session, exactly what /api/auth/logout does)...
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

test('checkPaidAccess: an unlinked (pre-membership) token keeps working signed-out, unchanged', async t => {
  const { raw, env } = fixture(t);
  const token = insertPaidOrder(raw, { phone: '0833333333', ownerUserId: null });
  const result = await checkPaidAccess({ env, request: req(origin + '/x') }, token);
  assert.equal(result.ok, true);
});

// The same three scenarios again through the REAL /api/check-access route
// (the client-polling unlock-status endpoint), so both call sites the audit
// named are proven, not just the shared helper.

test('check-access route: A logs out -> A\'s owner-bound token no longer reports ok', async t => {
  const { raw, env } = fixture(t);
  const token = insertPaidOrder(raw, { phone: '0844444444', ownerUserId: alice });
  const aliceToken = await signIn(raw, alice);
  const before = await checkAccessGet({ request: req(origin + '/api/check-access?token=' + token, { cookie: cookieOf(aliceToken) }), env });
  assert.equal((await before.json()).ok, true);
  await revoke(raw, aliceToken);
  const after = await checkAccessGet({ request: req(origin + '/api/check-access?token=' + token, { cookie: cookieOf(aliceToken) }), env });
  assert.equal((await after.json()).ok, false);
});

test('check-access route: B signed in cannot use A\'s owner-bound token', async t => {
  const { raw, env } = fixture(t);
  const token = insertPaidOrder(raw, { phone: '0844444444', ownerUserId: alice });
  const bobToken = await signIn(raw, bob);
  const res = await checkAccessGet({ request: req(origin + '/api/check-access?token=' + token, { cookie: cookieOf(bobToken) }), env });
  assert.equal((await res.json()).ok, false);
});

test('check-access route: an unlinked token still reports ok with no session at all', async t => {
  const { raw, env } = fixture(t);
  const token = insertPaidOrder(raw, { phone: '0844444444', ownerUserId: null });
  const res = await checkAccessGet({ request: req(origin + '/api/check-access?token=' + token), env });
  assert.equal((await res.json()).ok, true);
});

// ── Scenario 4: fail-closed expiry, everywhere access is granted ──────────

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

test('check-access route (phone branch) refuses NULL/malformed expiry the same way', async t => {
  const { raw, env } = fixture(t);
  raw.prepare(`INSERT INTO payments (phone, status, token, paid_at, expires_at) VALUES (?, 'paid', ?, datetime('now'), ?)`)
    .run('0866666666', 'tok-phone-bad', 'garbage');
  const res = await checkAccessGet({ request: req(origin + '/api/check-access?phone=0866666666'), env });
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

test('request-otp.js: a NULL/malformed expiry is never treated as a live customer', async t => {
  const { raw, env } = fixture(t);
  raw.prepare(`INSERT INTO payments (phone, status, token, paid_at, expires_at) VALUES (?, 'paid', ?, datetime('now'), NULL)`)
    .run('0955500001', 'tok-req-otp-null');
  const res = await requestOtpPost({ request: req(origin + '/api/request-otp', { method: 'POST', body: { phone: '0955500001' } }), env });
  const body = await res.json();
  assert.equal(body.ok, true); // same-answer decoy shape either way
  // No SMS should have been reserved for a row the expiry rule says is not live.
  const row = raw.prepare('SELECT sms_reserved FROM otp_challenges WHERE public_id = ?').get(body.challengeId);
  assert.equal(row.sms_reserved, 0);
});

test('verify-otp.js: a correct code against a NULL/malformed-expiry row is refused, not granted', async t => {
  const { raw, env } = fixture(t);
  raw.prepare(`INSERT INTO payments (phone, status, token, paid_at, expires_at) VALUES (?, 'paid', ?, datetime('now'), 'garbage')`)
    .run('0955500002', 'tok-verify-null');
  const e164 = toE164Thai('0955500002');
  const code = '135790';
  const codeHash = await hashCode(pepper, e164, code);
  const phoneHash = await hashPhone(pepper, e164);
  const insert = raw.prepare(
    `INSERT INTO otp_challenges (public_id, phone_hash, ip_hash, code_hash, created_at, expires_at, attempts, sms_reserved, purpose, send_status)
     VALUES (?, ?, 'iph', ?, datetime('now'), datetime('now','+5 minutes'), 0, 1, 'recovery', 'sent')`
  );
  const publicId = crypto.randomUUID();
  insert.run(publicId, phoneHash, codeHash);
  const res = await verifyOtpPost({ request: req(origin + '/api/verify-otp', { method: 'POST', body: { phone: '0955500002', code, challengeId: publicId } }), env });
  assert.equal((await res.json()).ok, false);
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
  const brokenEnv = { ...env, DB: badDb, STRIPE_SECRET_KEY: 'sk_test_x' };
  const aliceToken = await signIn(raw, alice); // a syntactically valid cookie; the lookup itself throws
  const res = await payPost({
    request: req(origin + '/api/pay', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone: '0811111111', age: 30 } }),
    env: brokenEnv
  });
  assert.equal(res.status, 503);
  const count = raw.prepare('SELECT COUNT(*) AS n FROM payments').get().n;
  assert.equal(count, 0, 'no ownerless order may be written when the session lookup itself failed');
});

// ── Scenario 3 & 5c/d: OTP purpose + account binding ───────────────────────

function overwriteCodeHash(raw, publicId, codeHash) {
  raw.prepare('UPDATE otp_challenges SET code_hash=? WHERE public_id=?').run(codeHash, publicId);
}

test('a recovery challenge cannot be consumed via the link flow, even with the right code', async t => {
  const { raw, env } = fixture(t);
  insertPaidOrder(raw, { phone: '0911111111', ownerUserId: null });
  const aliceToken = await signIn(raw, alice);
  const e164 = toE164Thai('0911111111');
  const code = '482913';
  const codeHash = await hashCode(pepper, e164, code);
  // Create a REAL recovery challenge via the real route.
  const reqRes = await requestOtpPost({ request: req(origin + '/api/request-otp', { method: 'POST', body: { phone: '0911111111' } }), env });
  const { challengeId } = await reqRes.json();
  overwriteCodeHash(raw, challengeId, codeHash);
  // Attempt to use it as a link_purchase confirmation.
  const attempt = await linkVerifyOtpPost({
    request: req(origin + '/api/member/link-verify-otp', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone: '0911111111', code, challengeId } }),
    env
  });
  assert.equal((await attempt.json()).ok, false);
  // And the reverse still works with a genuine recovery confirm on the same challenge.
  const recovered = await verifyOtpPost({ request: req(origin + '/api/verify-otp', { method: 'POST', body: { phone: '0911111111', code, challengeId } }), env });
  assert.equal((await recovered.json()).ok, true, 'a genuine recovery code must still work through its own flow');
});

test('a link_purchase challenge cannot be consumed via the recovery flow, even with the right code', async t => {
  const { raw, env } = fixture(t);
  insertPaidOrder(raw, { phone: '0922222222', ownerUserId: null });
  const aliceToken = await signIn(raw, alice);
  const e164 = toE164Thai('0922222222');
  const code = '736251';
  const codeHash = await hashCode(pepper, e164, code);
  const reqRes = await linkRequestOtpPost({
    request: req(origin + '/api/member/link-request-otp', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone: '0922222222' } }),
    env
  });
  const { challengeId } = await reqRes.json();
  overwriteCodeHash(raw, challengeId, codeHash);
  const attempt = await verifyOtpPost({ request: req(origin + '/api/verify-otp', { method: 'POST', body: { phone: '0922222222', code, challengeId } }), env });
  assert.equal((await attempt.json()).ok, false);
});

test('a link challenge requested by alice cannot be confirmed by bob, even with the right code', async t => {
  const { raw, env } = fixture(t);
  insertPaidOrder(raw, { phone: '0933333333', ownerUserId: null });
  const aliceToken = await signIn(raw, alice);
  const bobToken = await signIn(raw, bob);
  const e164 = toE164Thai('0933333333');
  const code = '918273';
  const codeHash = await hashCode(pepper, e164, code);
  const reqRes = await linkRequestOtpPost({
    request: req(origin + '/api/member/link-request-otp', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone: '0933333333' } }),
    env
  });
  const { challengeId } = await reqRes.json();
  overwriteCodeHash(raw, challengeId, codeHash);

  const bobAttempt = await linkVerifyOtpPost({
    request: req(origin + '/api/member/link-verify-otp', { method: 'POST', cookie: cookieOf(bobToken), body: { phone: '0933333333', code, challengeId } }),
    env
  });
  assert.equal((await bobAttempt.json()).ok, false);
  assert.equal(raw.prepare('SELECT owner_user_id FROM payments WHERE phone=?').get('0933333333').owner_user_id, null);

  const aliceAttempt = await linkVerifyOtpPost({
    request: req(origin + '/api/member/link-verify-otp', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone: '0933333333', code, challengeId } }),
    env
  });
  assert.equal((await aliceAttempt.json()).ok, true, 'the requesting account must still be able to confirm its own challenge');
  assert.equal(raw.prepare('SELECT owner_user_id FROM payments WHERE phone=?').get('0933333333').owner_user_id, alice);
});

// ── Scenario 5e: a challenge only ever links the ONE order bound at request
// time, never a fresh "latest unlinked" pick, even when a newer order shows
// up (or a race lands) between request and confirm ─────────────────────────

test('a link challenge stays bound to the order picked at request time, not whatever is newest at confirm time', async t => {
  const { raw, env } = fixture(t);
  const phone = '0944444444';
  const originalToken = insertPaidOrder(raw, { phone, ownerUserId: null, paidAt: "datetime('now', '-1 hour')" });
  const originalId = raw.prepare('SELECT id FROM payments WHERE token=?').get(originalToken).id;
  const aliceToken = await signIn(raw, alice);

  const e164 = toE164Thai(phone);
  const code = '246810';
  const codeHash = await hashCode(pepper, e164, code);
  const reqRes = await linkRequestOtpPost({
    request: req(origin + '/api/member/link-request-otp', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone } }),
    env
  });
  const { challengeId } = await reqRes.json();
  overwriteCodeHash(raw, challengeId, codeHash);
  const boundPaymentId = raw.prepare('SELECT payment_id FROM otp_challenges WHERE public_id=?').get(challengeId).payment_id;
  assert.equal(boundPaymentId, originalId);

  // A second, NEWER unlinked order for the same phone shows up after the
  // challenge was already issued -- simulating a fresh purchase landing in
  // the gap between requestLinkOtp and confirmLinkOtp.
  const newerToken = insertPaidOrder(raw, { phone, ownerUserId: null, paidAt: "datetime('now')" });

  const confirm = await linkVerifyOtpPost({
    request: req(origin + '/api/member/link-verify-otp', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone, code, challengeId } }),
    env
  });
  assert.equal((await confirm.json()).ok, true);

  const original = raw.prepare('SELECT owner_user_id FROM payments WHERE token=?').get(originalToken);
  const newer = raw.prepare('SELECT owner_user_id FROM payments WHERE token=?').get(newerToken);
  assert.equal(original.owner_user_id, alice, 'the order the challenge was actually bound to must be the one linked');
  assert.equal(newer.owner_user_id, null, 'a newer order that showed up later must never be substituted in');
});

test('concurrent confirm attempts for the same challenge link exactly once, never twice', async t => {
  const { raw, env } = fixture(t);
  const phone = '0955555555';
  insertPaidOrder(raw, { phone, ownerUserId: null });
  const aliceToken = await signIn(raw, alice);
  const e164 = toE164Thai(phone);
  const code = '113355';
  const codeHash = await hashCode(pepper, e164, code);
  const reqRes = await linkRequestOtpPost({
    request: req(origin + '/api/member/link-request-otp', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone } }),
    env
  });
  const { challengeId } = await reqRes.json();
  overwriteCodeHash(raw, challengeId, codeHash);

  const attempt = () => linkVerifyOtpPost({
    request: req(origin + '/api/member/link-verify-otp', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone, code, challengeId } }),
    env
  });
  const [r1, r2] = await Promise.all([attempt(), attempt()]);
  const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
  // Both may report success (the second can legitimately observe the link
  // that the first just wrote, or replay the same outcome) but the order
  // itself must end up linked to alice exactly once, never re-linked or
  // linked to two different accounts.
  assert.ok(b1.ok || b2.ok, 'at least one confirmation must succeed');
  const row = raw.prepare('SELECT owner_user_id FROM payments WHERE phone=?').get(phone);
  assert.equal(row.owner_user_id, alice);
});

// ── Scenario 5f: crash between "code accepted" and "ownership written" ────

test('a retry after consumeChallengeByPublicId succeeded but applyOwnerToOrder never ran completes the link exactly once', async t => {
  const { raw, env } = fixture(t);
  const phone = '0966666666';
  const token = insertPaidOrder(raw, { phone, ownerUserId: null });
  const aliceToken = await signIn(raw, alice);
  const e164 = toE164Thai(phone);
  const code = '998877';
  const codeHash = await hashCode(pepper, e164, code);
  const reqRes = await linkRequestOtpPost({
    request: req(origin + '/api/member/link-request-otp', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone } }),
    env
  });
  const { challengeId } = await reqRes.json();
  overwriteCodeHash(raw, challengeId, codeHash);

  // Simulate the crash directly: consume the code (this is what confirmLinkOtp
  // does internally) but deliberately never call applyOwnerToOrder -- exactly
  // what a worker dying right after "code accepted" looks like on disk.
  const consumed = await consumeChallengeByPublicId(env, {
    publicId: challengeId, codeHash, candidateToken: crypto.randomUUID(),
    purpose: 'link_purchase', userId: alice
  });
  assert.equal(consumed.ok, true);
  assert.equal(consumed.replay, false);
  // Still unlinked -- the crash landed before the write that matters.
  assert.equal(raw.prepare('SELECT owner_user_id FROM payments WHERE token=?').get(token).owner_user_id, null);

  // The retry: the full route is called again with the SAME code/challenge,
  // exactly as a client retrying a timed-out request would.
  const retry = await linkVerifyOtpPost({
    request: req(origin + '/api/member/link-verify-otp', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone, code, challengeId } }),
    env
  });
  const retryBody = await retry.json();
  assert.equal(retryBody.ok, true, 'the retry must finish the interrupted link, not fail it');
  assert.equal(raw.prepare('SELECT owner_user_id FROM payments WHERE token=?').get(token).owner_user_id, alice);

  // A second retry after it already succeeded must be a safe no-op, not a
  // re-link or an error that confuses the caller.
  const applied = await applyOwnerToOrder(env, { publicId: challengeId });
  assert.equal(applied.applied, false, 'once applied, re-applying must change nothing');
});

test('applyOwnerToOrder refuses to link an order that is no longer paid/live by confirm time', async t => {
  const { raw, env } = fixture(t);
  const phone = '0977777777';
  const token = insertPaidOrder(raw, { phone, ownerUserId: null, expiresAt: '2099-01-01 00:00:00' });
  const aliceToken = await signIn(raw, alice);
  const e164 = toE164Thai(phone);
  const code = '445566';
  const codeHash = await hashCode(pepper, e164, code);
  const reqRes = await linkRequestOtpPost({
    request: req(origin + '/api/member/link-request-otp', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone } }),
    env
  });
  const { challengeId } = await reqRes.json();
  overwriteCodeHash(raw, challengeId, codeHash);

  // The order the challenge was bound to lapses (expired, or refunded/
  // cancelled -- either way, status/expiry no longer says "paid and live")
  // in the gap between request and confirm.
  raw.prepare(`UPDATE payments SET expires_at = '2000-01-01 00:00:00' WHERE token = ?`).run(token);

  const attempt = await linkVerifyOtpPost({
    request: req(origin + '/api/member/link-verify-otp', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone, code, challengeId } }),
    env
  });
  assert.equal((await attempt.json()).ok, false, 'a code accepted for an order that has since expired must not grant ownership');
  assert.equal(raw.prepare('SELECT owner_user_id FROM payments WHERE token=?').get(token).owner_user_id, null);

  // And directly at the otp.mjs level, cancelled (non-'paid') is refused the same way.
  raw.prepare(`UPDATE payments SET expires_at = '2099-01-01 00:00:00', status = 'refunded' WHERE token = ?`).run(token);
  const applied = await applyOwnerToOrder(env, { publicId: challengeId });
  assert.equal(applied.applied, false, 'a cancelled/refunded order must never be linked even with an otherwise-valid challenge');
});

test('applyOwnerToOrder never grants ownership for a challenge that was never actually consumed/verified', async t => {
  // The exact bug Codex's review caught: a challenge with consumed_at=NULL
  // and issued_token=NULL (never went through consumeChallengeByPublicId at
  // all) must not be able to write ownership just because it otherwise looks
  // eligible (right purpose, payment_id/user_id set, token_applied=0,
  // not superseded). Calling order alone must never be what makes this safe.
  const { raw, env } = fixture(t);
  const phone = '0966611111';
  const token = insertPaidOrder(raw, { phone, ownerUserId: null });
  const aliceToken = await signIn(raw, alice);
  const reqRes = await linkRequestOtpPost({
    request: req(origin + '/api/member/link-request-otp', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone } }),
    env
  });
  const { challengeId } = await reqRes.json();
  const row = raw.prepare('SELECT consumed_at, issued_token FROM otp_challenges WHERE public_id=?').get(challengeId);
  assert.equal(row.consumed_at, null, 'requesting a code must never itself mark the challenge consumed');
  assert.equal(row.issued_token, null);

  const applied = await applyOwnerToOrder(env, { publicId: challengeId });
  assert.equal(applied.applied, false, 'an unconsumed challenge must be refused, not treated as verified');
  assert.equal(raw.prepare('SELECT owner_user_id FROM payments WHERE token=?').get(token).owner_user_id, null);
});

test('a retry after the owner write succeeded but token_applied was never set finishes safely, once, and never for a different challenge or account', async t => {
  const { raw, env } = fixture(t);
  const phone = '0988888888';
  const token = insertPaidOrder(raw, { phone, ownerUserId: null });
  const aliceToken = await signIn(raw, alice);
  const e164 = toE164Thai(phone);
  const code = '778899';
  const codeHash = await hashCode(pepper, e164, code);
  const reqRes = await linkRequestOtpPost({
    request: req(origin + '/api/member/link-request-otp', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone } }),
    env
  });
  const { challengeId } = await reqRes.json();
  overwriteCodeHash(raw, challengeId, codeHash);

  // The code IS actually verified first -- consumed_at must be genuinely set
  // before any crash simulation, or this test would not reproduce the real
  // crash window at all (a challenge that was never consumed is covered by
  // the test above, and must always be refused, never finished by retry).
  const consumed = await consumeChallengeByPublicId(env, {
    publicId: challengeId, codeHash, candidateToken: crypto.randomUUID(),
    purpose: 'link_purchase', userId: alice
  });
  assert.equal(consumed.ok, true);

  // Simulate the exact crash Codex's review flagged: applyOwnerToOrder's
  // OWN first statement (the write onto `payments`) already ran and
  // succeeded, but the process died before its second statement could mark
  // token_applied -- reproduced here with the identical UPDATE, run by
  // hand, stopping short of the second write.
  raw.prepare(
    `UPDATE payments
        SET owner_user_id = (SELECT user_id FROM otp_challenges WHERE public_id = ?1)
      WHERE owner_user_id IS NULL
        AND status = 'paid' AND datetime(expires_at) > datetime('now')
        AND id = (SELECT payment_id FROM otp_challenges WHERE public_id = ?1)`
  ).run(challengeId);
  assert.equal(raw.prepare('SELECT owner_user_id FROM payments WHERE token=?').get(token).owner_user_id, alice);
  assert.equal(raw.prepare('SELECT token_applied FROM otp_challenges WHERE public_id=?').get(challengeId).token_applied, 0);

  // The retry: calling applyOwnerToOrder again (exactly what a retried
  // confirm does after consumeChallengeByPublicId's replay branch) must
  // finish the interrupted write, not report failure and leave
  // token_applied stuck at 0 forever -- because THIS challenge is itself
  // verified (consumed_at set), still current, and not yet applied.
  const retried = await applyOwnerToOrder(env, { publicId: challengeId });
  assert.equal(retried.applied, true, 'the retry must recognise its own already-written, already-verified outcome and finish cleanly');
  assert.equal(raw.prepare('SELECT token_applied FROM otp_challenges WHERE public_id=?').get(challengeId).token_applied, 1);
  assert.equal(raw.prepare('SELECT owner_user_id FROM payments WHERE token=?').get(token).owner_user_id, alice, 'the owner must still be exactly the account this challenge was for');

  // A second retry afterwards is a safe no-op.
  const again = await applyOwnerToOrder(env, { publicId: challengeId });
  assert.equal(again.applied, false);

  // A different, unrelated, but FULLY VERIFIED challenge (consumed_at set,
  // still current, not yet applied) for a DIFFERENT account must still be
  // refused purely on the account mismatch -- equality of "owner_user_id ==
  // this challenge's own user_id" is necessary, and being consumed is not
  // sufficient by itself to earn a false positive.
  const bogusPublicId = crypto.randomUUID();
  raw.prepare(
    `INSERT INTO otp_challenges (public_id, phone_hash, ip_hash, code_hash, created_at, expires_at, attempts, sms_reserved, purpose, user_id, payment_id, token_applied, consumed_at, issued_token, send_status)
     VALUES (?, 'x-bogus', 'x', 'x', datetime('now'), datetime('now','+5 minutes'), 0, 0, 'link_purchase', ?, (SELECT id FROM payments WHERE token=?), 0, datetime('now'), 'forged-token', 'sent')`
  ).run(bogusPublicId, bob, token);
  const forged = await applyOwnerToOrder(env, { publicId: bogusPublicId });
  assert.equal(forged.applied, false, 'the order is owned by alice, not bob -- being consumed does not make a wrong-account challenge succeed');
  assert.equal(raw.prepare('SELECT owner_user_id FROM payments WHERE token=?').get(token).owner_user_id, alice, 'ownership must stay exactly as the legitimate challenge left it');
});

test('a challenge superseded by a newer request for the same phone cannot be finished as a retry, even if consumed and otherwise eligible', async t => {
  const { raw, env } = fixture(t);
  const phone = '0955511111';
  insertPaidOrder(raw, { phone, ownerUserId: null });
  const aliceToken = await signIn(raw, alice);
  const e164 = toE164Thai(phone);
  const code1 = '111000';
  const codeHash1 = await hashCode(pepper, e164, code1);
  const req1 = await linkRequestOtpPost({
    request: req(origin + '/api/member/link-request-otp', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone } }),
    env
  });
  const { challengeId: challenge1 } = await req1.json();
  overwriteCodeHash(raw, challenge1, codeHash1);
  const consumed1 = await consumeChallengeByPublicId(env, {
    publicId: challenge1, codeHash: codeHash1, candidateToken: crypto.randomUUID(),
    purpose: 'link_purchase', userId: alice
  });
  assert.equal(consumed1.ok, true, 'the first code is verified before it is superseded');

  // A second code is requested for the same phone before the first is
  // applied -- this is what makes challenge1 stale/superseded from here on.
  // The real per-phone cooldown (60s between sends) would otherwise refuse
  // this second request outright and leave no new row at all, so the first
  // challenge's created_at is pushed back first, exactly as if real time had
  // passed -- the request path itself is still exercised for real.
  raw.prepare(`UPDATE otp_challenges SET created_at = datetime(created_at, '-90 seconds') WHERE public_id = ?`).run(challenge1);
  const req2 = await linkRequestOtpPost({
    request: req(origin + '/api/member/link-request-otp', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone } }),
    env
  });
  const j2 = await req2.json();
  const row2 = raw.prepare(`SELECT send_status FROM otp_challenges WHERE public_id = ?`).get(j2.challengeId);
  assert.equal(row2 && row2.send_status, 'sent', 'the test setup itself must actually create a newer, sent challenge for this to prove anything');

  const retryOnStale = await applyOwnerToOrder(env, { publicId: challenge1 });
  assert.equal(retryOnStale.applied, false, 'a superseded challenge must never be finished, even though it was genuinely consumed');
});

test('requesting a link code for a stranger number gives the identical decoy answer (no enumeration)', async t => {
  const { raw, env } = fixture(t);
  const aliceToken = await signIn(raw, alice);
  const strangerResult = await linkRequestOtpPost({
    request: req(origin + '/api/member/link-request-otp', { method: 'POST', cookie: cookieOf(aliceToken), body: { phone: '0899999999' } }),
    env
  });
  const body = await strangerResult.json();
  assert.equal(body.ok, true);
  assert.ok(body.challengeId);
});

test('link-request-otp and link-verify-otp both require a signed-in caller', async t => {
  const { env } = fixture(t);
  const r1 = await linkRequestOtpPost({ request: req(origin + '/api/member/link-request-otp', { method: 'POST', body: { phone: '0811111111' } }), env });
  assert.equal(r1.status, 401);
  const r2 = await linkVerifyOtpPost({ request: req(origin + '/api/member/link-verify-otp', { method: 'POST', body: { phone: '0811111111', code: '123456', challengeId: 'x' } }), env });
  assert.equal(r2.status, 401);
});

// ── kill switch: closes recovery server-side, not just a hidden button ─────

test('recovery-mode reports closed only when the kill switch is set, ahead of the OTP switch', async t => {
  const closed = await recoveryModeGet({ env: { PURCHASE_RECOVERY_DISABLED: 'true', OTP_RECOVERY_ENABLED: 'true' } });
  assert.equal((await closed.json()).mode, 'closed');
  const otp = await recoveryModeGet({ env: { OTP_RECOVERY_ENABLED: 'true' } });
  assert.equal((await otp.json()).mode, 'otp');
  const phone = await recoveryModeGet({ env: {} });
  assert.equal((await phone.json()).mode, 'phone');
});

test('check-access phone recovery is refused server-side when the kill switch is on, even with OTP off', async t => {
  const env = { DB: {}, PURCHASE_RECOVERY_DISABLED: 'true' };
  const res = await checkAccessGet({ request: req('https://x/api/check-access?phone=0811111111'), env });
  assert.equal(res.status, 410);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'RECOVERY_CLOSED');
});

test('check-access token path stays open when the kill switch is on -- it is not recovery', async t => {
  const { raw, env } = fixture(t);
  const token = insertPaidOrder(raw, { phone: '0811111111', ownerUserId: null });
  const closedEnv = { ...env, PURCHASE_RECOVERY_DISABLED: 'true' };
  const res = await checkAccessGet({ request: req('https://x/api/check-access?token=' + token), env: closedEnv });
  const body = await res.json();
  assert.equal(body.ok, true, 'presenting a token you already hold must keep working when only recovery is closed');
});

test('request-otp and verify-otp both refuse before touching the phone/code when the kill switch is on', async t => {
  const env = { DB: {}, OTP_PEPPER: pepper, PURCHASE_RECOVERY_DISABLED: 'true' };
  const r1 = await requestOtpPost({ request: req('https://x/api/request-otp', { method: 'POST', body: { phone: '0811111111' } }), env });
  assert.equal(r1.status, 410);
  assert.equal((await r1.json()).code, 'RECOVERY_CLOSED');

  const r2 = await verifyOtpPost({ request: req('https://x/api/verify-otp', { method: 'POST', body: { phone: '0811111111', code: '123456', challengeId: 'x' } }), env });
  assert.equal(r2.status, 410);
  assert.equal((await r2.json()).code, 'RECOVERY_CLOSED');
});
