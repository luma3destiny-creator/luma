import { authOrigin, sameOrigin, json, headers, randomToken, hash, digest, base64url,
  ipHash, readCookie, cookie, validToken, nowSeconds, currentMember, createMemberSession, SESSION_COOKIE } from './member-session.mjs';
import { providerConfig, exchangeIdentity } from './member-providers.mjs';

const flowCookie = provider => '__Host-luma_oauth_' + provider;
const callbackPath = provider => `/api/auth/${provider}/callback`;
const unavailable = () => json({ ok: false, error: 'ระบบสมาชิกยังไม่พร้อมใช้งาน' }, 503);
const invalid = () => json({ ok: false, error: 'คำขอไม่ถูกต้อง กรุณาเริ่มเข้าสู่ระบบใหม่' }, 400);

export async function startLogin({ env, request, params }) {
  const origin = authOrigin(env, request);
  const provider = params.provider;
  const config = providerConfig(env, provider);
  if (!origin || !config) return unavailable();
  if (request.method !== 'POST' || !sameOrigin(request, origin)) return invalid();
  try {
    // Linking is deliberately separate: a login cannot silently replace/link an active account.
    if (await currentMember(env, request)) return json({ ok: false, error: 'คุณเข้าสู่ระบบแล้ว กรุณาออกจากระบบก่อนเปลี่ยนบัญชี' }, 409);
    const now = nowSeconds();
    const verifier = randomToken(), state = randomToken(), nonce = randomToken();
    const fingerprint = await ipHash(config.secret, request.headers.get('CF-Connecting-IP') || 'local');
    await env.DB.prepare('DELETE FROM oauth_transactions WHERE created_at<?').bind(now - 3600).run();
    const reserved = await env.DB.prepare(`INSERT INTO oauth_transactions
      (state_hash,provider,browser_hash,nonce,ip_hash,created_at,expires_at)
      SELECT ?,?,?,?,?,?,? WHERE
      (SELECT count(*) FROM oauth_transactions WHERE ip_hash=? AND created_at>?)<20
      AND (SELECT count(*) FROM oauth_transactions WHERE expires_at>? AND consumed_at IS NULL)<1000`)
      .bind(await hash(state), provider, await hash(verifier), nonce, fingerprint, now, now + 600, fingerprint, now - 3600, now).run();
    if (reserved.meta?.changes !== 1) return json({ ok: false, error: 'ลองเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่' }, 429);
    const url = new URL(config.authorize);
    url.search = new URLSearchParams({ response_type: 'code', client_id: config.id, redirect_uri: origin + callbackPath(provider),
      scope: config.scope, state, nonce, code_challenge: base64url(await digest(verifier)), code_challenge_method: 'S256' }).toString();
    const h = headers(); h.set('Location', url.href); h.append('Set-Cookie', cookie(flowCookie(provider), verifier, 600));
    return new Response(null, { status: 303, headers: h });
  } catch {
    console.error('member-auth: start_failed');
    return unavailable();
  }
}

export async function finishLogin({ env, request, params }) {
  const origin = authOrigin(env, request), provider = params.provider;
  const config = providerConfig(env, provider);
  if (!origin || !config) return unavailable();
  if (request.method !== 'GET') return invalid();
  const q = new URL(request.url).searchParams;
  const state = q.get('state'), verifier = readCookie(request, flowCookie(provider));
  if (q.getAll('state').length !== 1 || !validToken(state) || !validToken(verifier)) return invalid();
  const h = headers(); h.append('Set-Cookie', cookie(flowCookie(provider), '', 0));
  try {
    const now = nowSeconds();
    const txn = await env.DB.prepare(`UPDATE oauth_transactions SET consumed_at=?
      WHERE state_hash=? AND provider=? AND browser_hash=? AND consumed_at IS NULL AND expires_at>?
      RETURNING nonce`).bind(now, await hash(state), provider, await hash(verifier), now).first();
    if (!txn) return invalid();
    if (q.has('error')) {
      h.set('Location', origin + '/member?login=cancelled');
      return new Response(null, { status: 303, headers: h });
    }
    if (q.getAll('code').length !== 1 || !q.get('code') || q.get('code').length > 4096) return invalid();
    if (await currentMember(env, request)) {
      h.set('Location', origin + '/member');
      return new Response(null, { status: 303, headers: h });
    }
    const subject = await exchangeIdentity(config, provider, q.get('code'), origin + callbackPath(provider), verifier, txn.nonce);
    h.append('Set-Cookie', await createMemberSession(env, provider, subject, request));
    h.set('Location', origin + '/member');
    return new Response(null, { status: 303, headers: h });
  } catch {
    // No raw exception, code, query string, identity token or provider response in logs.
    console.error('member-auth: callback_failed');
    h.set('Location', origin + '/member?login=failed');
    return new Response(null, { status: 303, headers: h });
  }
}

export async function memberInfo({ env, request }) {
  if (!authOrigin(env, request)) return unavailable();
  try {
    const member = await currentMember(env, request);
    return json({ ok: true, signedIn: !!member, member: member ? { id: member.id } : null });
  } catch { return unavailable(); }
}
export async function logout({ env, request }) {
  const origin = authOrigin(env, request);
  if (!origin) return unavailable();
  if (request.method !== 'POST' || !sameOrigin(request, origin)) return invalid();
  try {
    const token = readCookie(request, SESSION_COOKIE);
    if (validToken(token)) await env.DB.prepare('UPDATE member_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL')
      .bind(nowSeconds(), await hash(token)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) });
  } catch { return unavailable(); }
}
