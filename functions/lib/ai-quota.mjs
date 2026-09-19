// functions/lib/ai-quota.mjs — how many AI calls anyone can cause.
//
// Every route that calls the AI provider goes through reserveAiCall() first.
// It exists because an AI call costs money whether or not the customer ever
// sees the result, and until now nothing stopped the same request being sent
// in a loop.
//
// WHAT THIS BOUNDS, AND WHAT IT DOES NOT
//
// It bounds the NUMBER of provider calls. It does not bound the BAHT spent.
// Each call's cost depends on the model, the prompt, the output length and,
// for face/palm reading, the image -- none of which this counts. A cap of 50
// calls a day is 50 calls, not a baht figure, and must never be reported as
// one. What it does guarantee is that the spend is bounded by
// (calls allowed) x (the most one call can cost), which is finite.
//
// THREE RULES THE CODE KEEPS
//
// 1. RESERVED, NOT CHECKED. The limit is enforced by the same single SQL
//    statement that records the call (INSERT ... SELECT ... WHERE count < cap).
//    Counting first and inserting afterwards lets N simultaneous requests all
//    see room for the last slot; as one statement, the database's own write
//    serialisation decides who gets it.
//
// 2. RESERVED BEFORE THE PROVIDER IS CALLED, AND NEVER GIVEN BACK. A call that
//    failed or timed out may still have been billed, so its slot is not
//    returned on a guess. Only requests that never reach the provider --
//    malformed input, no entitlement, no API key -- avoid a reservation, and
//    that is by the caller doing those checks FIRST.
//
// 3. FAILS CLOSED. No database, no table, a missing secret, or a nonsensical
//    limit all mean "do not call the AI". An outage of the quota system must
//    never turn into unlimited spending.
//
// WHO IS COUNTED
//
//   free  -- per client IP as Cloudflare reports it (cf-connecting-ip, which
//            Cloudflare sets itself and a client cannot override), plus one
//            ceiling across all free callers. The IP is never stored: only an
//            HMAC of it, keyed with AI_QUOTA_IP_SECRET, a secret used for
//            nothing else.
//   paid  -- per PAYMENT (payments.id), not per token. Recovering access
//            issues a new token; counting per token would hand out a fresh
//            allowance with every recovery. Plus one ceiling across all paid
//            callers, kept separate from the free one so a burst of free
//            traffic cannot use up paying customers' budget.
//
// Nothing personal is stored: no IP, name, birth date, image, report text or
// token. A row is: bucket, an opaque subject, the route, a time, an outcome.

export const AI_QUOTA_DEFAULTS = Object.freeze({
  // Conservative on purpose: these are the values Preview runs with when no
  // variable is set. Production should set its own, deliberately.
  freePerIp: 5,               freePerIpWindowSeconds: 86400,
  freeGlobal: 50,             freeGlobalWindowSeconds: 86400,
  paidPerPayment: 10,         paidPerPaymentWindowSeconds: 86400,
  paidGlobal: 100,            paidGlobalWindowSeconds: 86400
});

const MAX_WINDOW_SECONDS = 30 * 86400;   // a sanity bound, not a policy

function positiveInt(raw, fallback, { allowZero = true, max = 1e6 } = {}) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1) || n > max) return NaN;
  return n;
}

/**
 * Read the limits from the environment. Any value that is present but
 * unreadable makes the whole config invalid -- a typo in a limit must not
 * silently fall back to a default someone did not choose.
 */
export function readAiQuotaConfig(env) {
  const d = AI_QUOTA_DEFAULTS;
  const e = env || {};
  const cfg = {
    free: {
      perSubject: positiveInt(e.AI_QUOTA_FREE_PER_IP, d.freePerIp),
      perSubjectWindow: positiveInt(e.AI_QUOTA_FREE_PER_IP_WINDOW_SECONDS, d.freePerIpWindowSeconds, { allowZero: false, max: MAX_WINDOW_SECONDS }),
      global: positiveInt(e.AI_QUOTA_FREE_GLOBAL, d.freeGlobal),
      globalWindow: positiveInt(e.AI_QUOTA_FREE_GLOBAL_WINDOW_SECONDS, d.freeGlobalWindowSeconds, { allowZero: false, max: MAX_WINDOW_SECONDS })
    },
    paid: {
      perSubject: positiveInt(e.AI_QUOTA_PAID_PER_PAYMENT, d.paidPerPayment),
      perSubjectWindow: positiveInt(e.AI_QUOTA_PAID_PER_PAYMENT_WINDOW_SECONDS, d.paidPerPaymentWindowSeconds, { allowZero: false, max: MAX_WINDOW_SECONDS }),
      global: positiveInt(e.AI_QUOTA_PAID_GLOBAL, d.paidGlobal),
      globalWindow: positiveInt(e.AI_QUOTA_PAID_GLOBAL_WINDOW_SECONDS, d.paidGlobalWindowSeconds, { allowZero: false, max: MAX_WINDOW_SECONDS })
    }
  };
  const ok = [cfg.free, cfg.paid].every(b =>
    [b.perSubject, b.perSubjectWindow, b.global, b.globalWindow].every(Number.isFinite));
  return ok ? { ok: true, ...cfg } : { ok: false };
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The client IP as Cloudflare reports it. Never X-Forwarded-For, which the client writes. */
export function cloudflareClientIp(request) {
  const get = request && request.headers && request.headers.get ? (k) => request.headers.get(k) : () => null;
  const ip = (get('cf-connecting-ip') || '').trim();
  return ip && ip.length <= 64 ? ip : null;
}

const MESSAGES = {
  limited: 'มีการใช้งานครบจำนวนที่กำหนดแล้ว กรุณาลองใหม่ภายหลัง',
  unavailable: 'ระบบยังไม่พร้อมให้บริการส่วนนี้ชั่วคราว กรุณาลองใหม่ภายหลัง'
};

/**
 * Reserve one AI call. Call this AFTER every check that can reject the request
 * without spending (input, entitlement, API key) and IMMEDIATELY BEFORE the
 * provider call.
 *
 *   bucket  'free' | 'paid'
 *   route   the endpoint name, for the operator's counts
 *   request needed for 'free' (the Cloudflare client IP)
 *   paymentId needed for 'paid'
 *
 * Returns { ok:true, reservationId } or { ok:false, status, error, code }.
 */
export async function reserveAiCall(env, { bucket, route, request, paymentId }) {
  const cfg = readAiQuotaConfig(env);
  if (!cfg.ok) {
    console.error('ai-quota: limits are misconfigured — refusing to call AI');
    return deny(503, 'AI_QUOTA_MISCONFIGURED', MESSAGES.unavailable);
  }
  if (!env || !env.DB) return deny(503, 'AI_QUOTA_UNAVAILABLE', MESSAGES.unavailable);

  let subject;
  const limits = cfg[bucket];
  if (bucket === 'free') {
    if (!env.AI_QUOTA_IP_SECRET) {
      console.error('ai-quota: AI_QUOTA_IP_SECRET not set — refusing to call AI');
      return deny(503, 'AI_QUOTA_MISCONFIGURED', MESSAGES.unavailable);
    }
    const ip = cloudflareClientIp(request);
    if (!ip) {
      // Without the address Cloudflare vouches for there is nothing to count
      // against, and counting everyone as one "unknown" would let a single
      // caller exhaust it for all. Refuse rather than guess.
      return deny(503, 'AI_QUOTA_NO_CLIENT', MESSAGES.unavailable);
    }
    subject = 'ip:' + await hmacHex(env.AI_QUOTA_IP_SECRET, ip);
  } else if (bucket === 'paid') {
    const id = Number(paymentId);
    if (!Number.isInteger(id) || id <= 0) return deny(503, 'AI_QUOTA_NO_SUBJECT', MESSAGES.unavailable);
    subject = 'pay:' + id;
  } else {
    return deny(503, 'AI_QUOTA_BAD_BUCKET', MESSAGES.unavailable);
  }

  try {
    const res = await env.DB.prepare(
      `INSERT INTO ai_quota_events (bucket, subject, route, created_at, outcome)
       SELECT ?1, ?2, ?3, datetime('now'), 'reserved'
        WHERE (SELECT COUNT(*) FROM ai_quota_events
                WHERE bucket = ?1 AND subject = ?2
                  AND created_at > datetime('now', ?4)) < ?5
          AND (SELECT COUNT(*) FROM ai_quota_events
                WHERE bucket = ?1
                  AND created_at > datetime('now', ?6)) < ?7`
    ).bind(
      bucket, subject, String(route || '').slice(0, 40),
      '-' + limits.perSubjectWindow + ' seconds', limits.perSubject,
      '-' + limits.globalWindow + ' seconds', limits.global
    ).run();

    const changes = res && res.meta && typeof res.meta.changes === 'number' ? res.meta.changes
                  : (res && typeof res.changes === 'number' ? res.changes : 0);
    if (changes === 0) {
      return deny(429, 'AI_QUOTA_EXCEEDED', MESSAGES.limited, Math.min(limits.perSubjectWindow, 3600));
    }
    const id = (res.meta && res.meta.last_row_id) || res.lastInsertRowid || null;
    return { ok: true, reservationId: id == null ? null : Number(id) };
  } catch (e) {
    // No table, database down, anything: do not call the AI.
    console.error('ai-quota: reservation failed — refusing to call AI');
    return deny(503, 'AI_QUOTA_UNAVAILABLE', MESSAGES.unavailable);
  }
}

/**
 * Note how the call ended, for the operator's counts. Purely informational:
 * the slot is spent either way and is never returned. A failure to record
 * this is ignored -- the reservation already did the job that matters.
 *   'ok' | 'provider_error' (the provider answered with an error)
 *   'unknown' (no answer: timeout, network error -- may still be billed)
 */
export async function recordAiOutcome(env, reservationId, outcome) {
  if (!reservationId || !env || !env.DB) return;
  try {
    await env.DB.prepare(`UPDATE ai_quota_events SET outcome = ? WHERE id = ?`)
      .bind(outcome, reservationId).run();
  } catch (e) { /* informational only */ }
}

export function quotaResponse(denied) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (denied.retryAfter) headers['Retry-After'] = String(denied.retryAfter);
  return new Response(JSON.stringify({ ok: false, error: denied.error, code: denied.code }),
                      { status: denied.status, headers });
}

function deny(status, code, error, retryAfter) {
  return { ok: false, status, code, error, retryAfter };
}

// ── request size ─────────────────────────────────────────────────────────────

/**
 * Parse a JSON body without reading more than maxBytes. A large body costs
 * little to receive but a lot to forward: most of these routes paste the input
 * straight into the prompt, so an oversized field is an oversized bill.
 * Returns { ok:true, body } or { ok:false, response }.
 */
export async function readJsonBody(request, maxBytes) {
  const declared = Number(request.headers && request.headers.get && request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, response: tooLarge() };
  let text;
  try { text = await request.text(); } catch { return { ok: false, response: badJson() }; }
  // Content-Length can be absent or wrong, so the real size decides.
  if (new TextEncoder().encode(text).length > maxBytes) return { ok: false, response: tooLarge() };
  let body;
  try { body = JSON.parse(text); } catch { return { ok: false, response: badJson() }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, response: badJson() };
  return { ok: true, body };
}

/** A string field no longer than max, or empty. Anything else is refused. */
export function boundedText(value, max) {
  if (value === undefined || value === null) return { ok: true, value: '' };
  if (typeof value !== 'string' && typeof value !== 'number') return { ok: false };
  const s = String(value);
  return s.length <= max ? { ok: true, value: s } : { ok: false };
}

function tooLarge() {
  return new Response(JSON.stringify({ ok: false, error: 'ข้อมูลที่ส่งมามีขนาดใหญ่เกินไป', code: 'PAYLOAD_TOO_LARGE' }),
    { status: 413, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}
function badJson() {
  return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON' }),
    { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}
