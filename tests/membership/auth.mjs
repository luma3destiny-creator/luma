import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { startLogin, finishLogin, memberInfo, logout } from '../../functions/lib/member-auth.mjs';
import { hash, createMemberSession, currentMember, SESSION_COOKIE, nowSeconds } from '../../functions/lib/member-session.mjs';
import { verifyGoogleToken, checkClaims } from '../../functions/lib/member-providers.mjs';

const origin = 'https://www.lumahoro.com';
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  for (const name of ['011_membership_core.sql', '012_oauth_transactions.sql']) {
    db.exec(readFileSync(new URL('../../migrations/' + name, import.meta.url), 'utf8'));
  }
  const prep = (sql, args = []) => ({
    bind: (...a) => prep(sql, a),
    first: () => db.prepare(sql).get(...args) || null,
    run: () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } })
  });
  const DB = { prepare: prep, batch: async stmts => {
    db.exec('BEGIN');
    try { const r = stmts.map(s => s.run()); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  } };
  const env = { DB, MEMBERSHIP_ENABLED: 'true', AUTH_ORIGIN: origin,
    LINE_CHANNEL_ID: 'test-line', LINE_CHANNEL_SECRET: 'fake-line-secret',
    GOOGLE_CLIENT_ID: 'test-google', GOOGLE_CLIENT_SECRET: 'fake-google-secret' };
  return { db, env };
}
function request(path, { method = 'GET', cookie = '', same = true } = {}) {
  return new Request(origin + path, { method, headers: { Cookie: cookie, ...(method === 'POST' ? { Origin: same ? origin : 'https://evil.invalid' } : {}) } });
}
async function begin(env, provider = 'line') {
  const response = await startLogin({ env, params: { provider }, request: request(`/api/auth/${provider}/start`, { method: 'POST' }) });
  assert.equal(response.status, 303);
  const target = new URL(response.headers.get('Location'));
  const cookie = response.headers.get('Set-Cookie').split(';')[0];
  return { target, cookie, state: target.searchParams.get('state'), nonce: target.searchParams.get('nonce'), provider };
}
const callback = (env, flow, cookie = flow.cookie) => finishLogin({ env, params: { provider: flow.provider },
  request: request(`/api/auth/${flow.provider}/callback?state=${flow.state}&code=fake-code`, { cookie }) });
function stubLine(t, flow, overrides = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'manual');
    if (url.endsWith('/token')) {
      assert.equal(options.body.get('code_verifier'), flow.cookie.split('=')[1]);
      assert.equal(options.body.get('redirect_uri'), origin + '/api/auth/line/callback');
      return Response.json({ id_token: 'fake-id-token' });
    }
    assert.equal(url, 'https://api.line.me/oauth2/v2.1/verify');
    assert.equal(options.body.get('nonce'), flow.nonce);
    return Response.json({ iss: 'https://access.line.me', aud: 'test-line', sub: 'line-user', nonce: flow.nonce,
      iat: nowSeconds(), exp: nowSeconds() + 600, ...overrides });
  });
  return calls;
}

test('disabled, wrong host, unknown provider and cross-origin starts do not reserve state', async t => {
  const { env, db } = fixture(t);
  for (const ctx of [
    { env: { ...env, MEMBERSHIP_ENABLED: 'false' }, params: { provider: 'line' }, request: request('/start', { method: 'POST' }) },
    { env, params: { provider: '__proto__' }, request: request('/start', { method: 'POST' }) },
    { env, params: { provider: 'line' }, request: new Request('https://evil.invalid/start', { method: 'POST' }) },
    { env, params: { provider: 'line' }, request: request('/start', { method: 'POST', same: false }) }
  ]) assert.ok((await startLogin(ctx)).status >= 400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM oauth_transactions').get().n, 0);
});

test('start stores hashes, binds browser and uses PKCE without leaking secrets', async t => {
  const { env, db } = fixture(t);
  const flow = await begin(env);
  const row = db.prepare('SELECT * FROM oauth_transactions').get();
  assert.equal(row.state_hash, await hash(flow.state));
  assert.equal(row.browser_hash, await hash(flow.cookie.split('=')[1]));
  assert.equal(flow.target.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(flow.target.searchParams.get('scope'), 'openid');
  assert.equal(flow.target.href.includes(env.LINE_CHANNEL_SECRET), false);
  assert.equal(JSON.stringify(row).includes(flow.cookie.split('=')[1]), false);
});

test('LINE login creates a member and hashed session; callback replay makes no provider call', async t => {
  const { env, db } = fixture(t); const flow = await begin(env); const calls = stubLine(t, flow);
  const response = await callback(env, flow);
  assert.equal(response.headers.get('Location'), origin + '/member');
  const setCookie = response.headers.getSetCookie().find(c => c.startsWith(SESSION_COOKIE + '='));
  assert.ok(setCookie.includes('Secure; HttpOnly; SameSite=Lax'));
  const cookie = setCookie.split(';')[0];
  assert.equal(db.prepare('SELECT token_hash FROM member_sessions').get().token_hash, await hash(cookie.split('=')[1]));
  const me = await (await memberInfo({ env, request: request('/api/auth/me', { cookie }) })).json();
  assert.equal(me.signedIn, true);
  assert.equal(Object.hasOwn(me, 'token'), false);
  assert.equal((await callback(env, flow)).status, 400);
  assert.equal(calls.length, 2);
});

test('wrong browser, expired state and wrong provider fail before exchanging code', async t => {
  const { env, db } = fixture(t); const flow = await begin(env);
  const calls = stubLine(t, flow);
  assert.equal((await callback(env, flow, flow.cookie.slice(0, -1) + '!')).status, 400);
  assert.equal((await callback(env, { ...flow, provider: 'google' })).status, 400);
  db.prepare('UPDATE oauth_transactions SET created_at=?, expires_at=?').run(nowSeconds() - 601, nowSeconds() - 1);
  assert.equal((await callback(env, flow)).status, 400);
  assert.equal(calls.length, 0);
});

test('LINE wrong nonce cannot create an account or session', async t => {
  const { env, db } = fixture(t); const flow = await begin(env); stubLine(t, flow, { nonce: 'wrong' });
  assert.equal((await callback(env, flow)).headers.get('Location'), origin + '/member?login=failed');
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
});

test('provider redirects are rejected without forwarding code or client secret', async t => {
  const { env, db } = fixture(t); const flow = await begin(env); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++; assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://evil.invalid' } });
  });
  assert.equal((await callback(env, flow)).headers.get('Location'), origin + '/member?login=failed');
  assert.equal(calls, 1); assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
});

test('session expiry, disabled account, cross-origin logout and revocation', async t => {
  const { env, db } = fixture(t);
  const cookie = (await createMemberSession(env, 'line', 'subject', request('/'))).split(';')[0];
  const member = await currentMember(env, request('/', { cookie })); assert.ok(member);
  assert.equal((await logout({ env, request: request('/api/auth/logout', { method: 'POST', cookie, same: false }) })).status, 400);
  assert.ok(await currentMember(env, request('/', { cookie })));
  db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(member.id);
  assert.equal(await currentMember(env, request('/', { cookie })), null);
  db.prepare("UPDATE users SET status='active' WHERE id=?").run(member.id);
  assert.equal((await logout({ env, request: request('/api/auth/logout', { method: 'POST', cookie }) })).status, 200);
  assert.equal(await currentMember(env, request('/', { cookie })), null);
  const fresh = (await createMemberSession(env, 'line', 'subject', request('/'))).split(';')[0];
  db.prepare('UPDATE member_sessions SET created_at=0, expires_at=1').run();
  assert.equal(await currentMember(env, request('/', { cookie: fresh })), null);
});

test('repeated identity sign-ins reuse member; another provider never auto-merges', async t => {
  const { env, db } = fixture(t);
  await Promise.all([createMemberSession(env, 'line', 'subject', request('/')), createMemberSession(env, 'line', 'subject', request('/'))]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  await createMemberSession(env, 'google', 'subject', request('/'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 2);
});

test('auth start rate limit is retained after callbacks', async t => {
  const { env, db } = fixture(t);
  for (let i = 0; i < 20; i++) await begin(env);
  db.exec('UPDATE oauth_transactions SET consumed_at=created_at');
  const response = await startLogin({ env, params: { provider: 'line' }, request: request('/start', { method: 'POST' }) });
  assert.equal(response.status, 429);
});

test('Google JWT signature, issuer, audience, expiry and nonce are verified', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'test-key'; jwk.alg = 'RS256';
  const keys = createLocalJWKSet({ keys: [jwk] });
  const claims = { iss: 'https://accounts.google.com', aud: 'test-google', sub: 'google-user', nonce: 'expected', iat: nowSeconds(), exp: nowSeconds() + 600 };
  const sign = p => new SignJWT(p).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
  assert.equal(await verifyGoogleToken(await sign(claims), 'test-google', 'expected', keys), 'google-user');
  for (const patch of [{ iss: 'evil' }, { aud: 'another-client' }, { exp: 1 }, { nonce: 'wrong' }, { azp: 'another-client' }, { sub: '' }]) {
    await assert.rejects(verifyGoogleToken(await sign({ ...claims, ...patch }), 'test-google', 'expected', keys));
  }
  const token = await sign(claims); const parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...claims, sub: 'attacker' })).toString('base64url');
  await assert.rejects(verifyGoogleToken(parts.join('.'), 'test-google', 'expected', keys));
  assert.throws(() => checkClaims({ ...claims, iat: nowSeconds() + 10000 }, 'google', 'test-google', 'expected'));
});
