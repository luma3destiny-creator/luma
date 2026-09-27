export const SESSION_COOKIE = '__Host-luma_session';
export const SESSION_SECONDS = 7 * 24 * 3600;
const encoder = new TextEncoder();
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
export function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}
export async function hash(value) {
  return Array.from(await digest(value), b => b.toString(16).padStart(2, '0')).join('');
}
export async function ipHash(secret, ip) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode('luma-auth-ip:' + ip))));
}
export function readCookie(request, name) {
  const values = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).filter(s => s.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}
export const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export function cookie(name, value, seconds) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
}
export function headers() {
  return new Headers({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
}
export function json(body, status = 200, extra = {}) {
  const h = headers();
  h.set('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(JSON.stringify(body), { status, headers: h });
}
export function authOrigin(env, request) {
  if (env.MEMBERSHIP_ENABLED !== 'true' || !env.DB || !env.AUTH_ORIGIN) return null;
  try {
    const u = new URL(env.AUTH_ORIGIN);
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
    return new URL(request.url).origin === u.origin ? u.origin : null;
  } catch { return null; }
}
export function sameOrigin(request, origin) {
  return request.headers.get('Origin') === origin && request.headers.get('Sec-Fetch-Site') !== 'cross-site';
}
export async function currentMember(env, request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!validToken(token)) return null;
  return await env.DB.prepare(`SELECT u.id FROM member_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.status='active'`)
    .bind(await hash(token), nowSeconds()).first();
}
export async function createMemberSession(env, provider, subject, request) {
  const candidate = crypto.randomUUID();
  // D1 batch is atomic. Concurrent callbacks reuse the existing identity owner.
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users(id) VALUES (?)').bind(candidate),
    env.DB.prepare(`INSERT INTO auth_identities(provider,provider_subject,user_id) VALUES (?,?,?)
      ON CONFLICT(provider,provider_subject) DO NOTHING`).bind(provider, subject, candidate),
    env.DB.prepare('DELETE FROM users WHERE id=? AND NOT EXISTS (SELECT 1 FROM auth_identities WHERE user_id=?)').bind(candidate, candidate)
  ]);
  const owner = await env.DB.prepare(`SELECT u.id FROM auth_identities i JOIN users u ON u.id=i.user_id
    WHERE i.provider=? AND i.provider_subject=? AND u.status='active'`).bind(provider, subject).first();
  if (!owner) throw new Error('member_unavailable');
  const oldToken = readCookie(request, SESSION_COOKIE);
  const token = randomToken();
  const now = nowSeconds();
  const statements = [];
  if (validToken(oldToken)) statements.push(env.DB.prepare('UPDATE member_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL').bind(now, await hash(oldToken)));
  statements.push(env.DB.prepare(`INSERT INTO member_sessions(token_hash,user_id,created_at,expires_at)
    SELECT ?,id,?,? FROM users WHERE id=? AND status='active'`).bind(await hash(token), now, now + SESSION_SECONDS, owner.id));
  const results = await env.DB.batch(statements);
  if (results.at(-1)?.meta?.changes !== 1) throw new Error('member_unavailable');
  return cookie(SESSION_COOKIE, token, SESSION_SECONDS);
}
