import { createRemoteJWKSet, jwtVerify } from 'jose';
import { nowSeconds } from './member-session.mjs';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { timeoutDuration: 10000 });
export function providerConfig(env, provider) {
  const configs = {
    line: { id: env.LINE_CHANNEL_ID, secret: env.LINE_CHANNEL_SECRET,
      authorize: 'https://access.line.me/oauth2/v2.1/authorize', token: 'https://api.line.me/oauth2/v2.1/token', scope: 'openid' },
    google: { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET,
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'openid' }
  };
  if (!Object.hasOwn(configs, provider)) return null;
  const c = configs[provider];
  return typeof c.id === 'string' && c.id.trim() && typeof c.secret === 'string' && c.secret.trim() ? c : null;
}
async function postForm(url, body) {
  const res = await fetch(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  if (!res.ok) throw new Error('provider_rejected');
  const data = await res.json();
  if (!data || typeof data !== 'object') throw new Error('provider_invalid');
  return data;
}
export function checkClaims(payload, provider, clientId, nonce) {
  const issuers = provider === 'google' ? ['https://accounts.google.com', 'accounts.google.com'] : ['https://access.line.me'];
  if (!issuers.includes(payload.iss) || payload.aud !== clientId || payload.nonce !== nonce ||
      !Number.isFinite(payload.exp) || payload.exp <= nowSeconds() ||
      !Number.isFinite(payload.iat) || payload.iat > nowSeconds() + 60 ||
      (payload.azp !== undefined && payload.azp !== clientId) ||
      typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 255) throw new Error('invalid_identity');
  return payload.sub;
}
export async function verifyGoogleToken(idToken, clientId, nonce, keySet = googleKeys) {
  const { payload } = await jwtVerify(idToken, keySet, {
    algorithms: ['RS256'], issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: clientId,
    requiredClaims: ['exp', 'iat', 'sub', 'nonce']
  });
  return checkClaims(payload, 'google', clientId, nonce);
}
export async function exchangeIdentity(config, provider, code, redirectUri, verifier, nonce) {
  const tokens = await postForm(config.token, { grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: config.id, client_secret: config.secret, code_verifier: verifier });
  if (typeof tokens.id_token !== 'string' || tokens.id_token.length > 16384) throw new Error('missing_identity');
  if (provider === 'google') return await verifyGoogleToken(tokens.id_token, config.id, nonce);
  // LINE validates the signature and nonce itself; also assert essential claims locally.
  const claims = await postForm('https://api.line.me/oauth2/v2.1/verify', { id_token: tokens.id_token, client_id: config.id, nonce });
  return checkClaims(claims, 'line', config.id, nonce);
}
