// Runtime compatibility smoke only; SQLite integration is in ../auth.mjs.
// Provider calls are stubbed. No real account, OAuth credential, SMS or AI is used.
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import { onRequestPost as start } from '../../../functions/api/auth/[provider]/start.js';
import { onRequestGet as me } from '../../../functions/api/auth/me.js';
import { onRequestGet as finish } from '../../../functions/api/auth/[provider]/callback.js';
import { onRequestPost as logout } from '../../../functions/api/auth/logout.js';
import { exchangeIdentity, verifyGoogleToken } from '../../../functions/lib/member-providers.mjs';

export default { async fetch() {
  const checks = [];
  const assert = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };
  const origin = 'https://www.lumahoro.com';
  const request = new Request(origin + '/api/auth/line/start', { method: 'POST', headers: { Origin: origin } });
  const DB = { prepare: () => ({ bind() { return this; }, run: async () => ({ meta: { changes: 1 } }), first: async () => null }) };
  const env = { MEMBERSHIP_ENABLED: 'true', AUTH_ORIGIN: origin, DB, LINE_CHANNEL_ID: 'test', LINE_CHANNEL_SECRET: 'fake' };
  try {
    assert((await start({ env, request, params: { provider: 'line' } })).status === 303, 'start with crypto and PKCE');
    assert((await me({ env, request: new Request(origin + '/api/auth/me') })).status === 200, 'member info');
    assert((await finish({ env, request: new Request(origin + '/api/auth/line/callback'), params: { provider: 'line' } })).status === 400, 'callback rejects missing state');
    assert((await logout({ env, request })).status === 200, 'logout');
    const keys = await generateKeyPair('RS256');
    const jwk = await exportJWK(keys.publicKey); jwk.kid = 'test'; jwk.alg = 'RS256';
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({ nonce: 'nonce' }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer('https://accounts.google.com').setAudience('client').setSubject('test-user').setIssuedAt(now).setExpirationTime(now + 300).sign(keys.privateKey);
    assert(await verifyGoogleToken(idToken, 'client', 'nonce', createLocalJWKSet({ keys: [jwk] })) === 'test-user', 'Google JWT on workerd');
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, options) => {
        const actual = new Request(url, options);
        assert(actual.redirect === 'manual', 'provider redirect mode');
        return Response.json(url.endsWith('/token') ? { id_token: 'test-id' } : {
          iss: 'https://access.line.me', aud: 'client', sub: 'line-user', nonce: 'nonce', iat: now, exp: now + 300
        });
      };
      assert(await exchangeIdentity({ token: 'https://api.line.me/oauth2/v2.1/token', id: 'client', secret: 'fake' },
        'line', 'code', origin + '/api/auth/line/callback', 'verifier', 'nonce') === 'line-user', 'LINE exchange on workerd');
    } finally { globalThis.fetch = originalFetch; }
    return Response.json({ ok: true, checks });
  } catch (e) { return Response.json({ ok: false, checks, error: e.message }, { status: 500 }); }
} };
