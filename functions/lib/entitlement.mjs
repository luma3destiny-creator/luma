// functions/lib/entitlement.mjs — the single source of truth for "is this
// payment real, and has this order already been granted access?"
//
// Both /api/verify (the browser polling after checkout) and /api/stripe-webhook
// (Stripe telling us out-of-band) go through here, so the two paths cannot
// drift apart and cannot disagree about what counts as paid.
//
// The central rule: ENTITLEMENT IS GRANTED EXACTLY ONCE PER ORDER.
// Re-checking an already-confirmed payment — however many times, from however
// many callers, concurrently — must return the same paid_at, the same
// expires_at and the same token. It must never slide the clock forward.
// The previous implementation reset paid_at/expires_at on every check, so a
// customer (or anyone who knew the PaymentIntent id) could keep re-triggering
// /api/verify to extend their access indefinitely.

// The plan, in one place. Changing any of these changes what customers are
// sold, so they are deliberately not scattered across handlers.
export const PLAN = {
  amount: 5900,            // satang — ฿59
  currency: 'thb',
  // Unchanged from the original implementation: one calendar month, computed
  // by SQLite's own date arithmetic. Deliberately NOT rewritten as "30 days".
  durationModifier: '+1 month'
};

/**
 * Is this Stripe PaymentIntent an acceptable proof of payment for this order?
 * Checks far more than the old code did: it used to accept any succeeded
 * PaymentIntent whose id was passed in, without ever confirming the amount,
 * the currency, or that the intent actually belongs to the order being paid.
 *
 * @returns {{ok:true} | {ok:false, status:number, code:string, error:string}}
 */
export function validatePaymentIntent(pi, row) {
  if (!pi || typeof pi !== 'object') {
    return { ok: false, status: 502, code: 'PI_MISSING', error: 'ไม่สามารถตรวจสอบการชำระเงินได้ กรุณาลองใหม่' };
  }

  if (pi.status !== 'succeeded') {
    return { ok: false, status: 402, code: 'PI_NOT_SUCCEEDED', error: 'การชำระเงินยังไม่สำเร็จ รอสักครู่แล้วลองใหม่' };
  }

  // The intent must be the one recorded against this order, not merely some
  // succeeded intent the caller happens to know the id of.
  if (row && row.charge_id && pi.id && pi.id !== row.charge_id) {
    return { ok: false, status: 409, code: 'PI_ORDER_MISMATCH', error: 'รายการชำระเงินไม่ตรงกับคำสั่งซื้อ' };
  }

  if (String(pi.currency || '').toLowerCase() !== PLAN.currency) {
    return { ok: false, status: 409, code: 'PI_CURRENCY_MISMATCH', error: 'สกุลเงินของรายการชำระเงินไม่ถูกต้อง' };
  }

  // Prefer amount_received (what actually settled) and fall back to amount.
  const received = Number(pi.amount_received ?? pi.amount);
  const expected = Number(row && row.amount != null ? row.amount : PLAN.amount);
  if (!Number.isFinite(received) || received !== expected) {
    return { ok: false, status: 409, code: 'PI_AMOUNT_MISMATCH', error: 'ยอดชำระเงินไม่ตรงกับคำสั่งซื้อ' };
  }

  return { ok: true };
}

function changesOf(result) {
  // D1 returns { success, meta: { changes, ... } }. Be defensive so a shape
  // change can never be silently read as "0 rows changed" or vice versa.
  if (!result) return 0;
  if (result.meta && typeof result.meta.changes === 'number') return result.meta.changes;
  if (typeof result.changes === 'number') return result.changes;
  return 0;
}

async function readOrder(env, chargeId) {
  return env.DB.prepare(
    `SELECT id, phone, amount, status, token, paid_at, expires_at, charge_id
       FROM payments WHERE charge_id = ? LIMIT 1`
  ).bind(chargeId).first();
}

/**
 * Grant access for a confirmed order, at most once, safely under concurrency.
 *
 * Concurrency is handled by making the grant a single conditional UPDATE
 * (`WHERE status <> 'paid'`). Whichever request wins gets changes=1 and is the
 * one that set the dates; every other concurrent request gets changes=0 and
 * simply reads back what the winner wrote. No request ever overwrites another's
 * values, and `token` is written with COALESCE so a token already handed to a
 * customer (e.g. by an in-flight recovery) is never swapped out from under them.
 *
 * @returns {{ok:true, granted:boolean, token:string, paid_at:string, expires_at:string}
 *          | {ok:false, status:number, code:string, error:string}}
 */
export async function grantEntitlementOnce(env, chargeId, { now = null } = {}) {
  const existing = await readOrder(env, chargeId);
  if (!existing) {
    return { ok: false, status: 404, code: 'ORDER_NOT_FOUND', error: 'ไม่พบข้อมูลการชำระเงิน' };
  }

  const candidateToken = crypto.randomUUID();
  const nowExpr = now ? `'${now}'` : `datetime('now')`;

  // ── first-time grant: fires for exactly one caller ───────────────────────
  const res = await env.DB.prepare(
    `UPDATE payments
        SET status     = 'paid',
            token      = COALESCE(token, ?),
            paid_at    = COALESCE(paid_at, ${nowExpr}),
            expires_at = COALESCE(expires_at, datetime(${nowExpr}, '${PLAN.durationModifier}'))
      WHERE charge_id = ? AND status <> 'paid'`
  ).bind(candidateToken, chargeId).run();

  const granted = changesOf(res) > 0;

  // Always read back the stored row: never return a value we merely hoped we wrote.
  let row = await readOrder(env, chargeId);
  if (!row) {
    return { ok: false, status: 500, code: 'ORDER_VANISHED', error: 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง' };
  }

  // ── repair paths for legacy/incomplete rows ──────────────────────────────
  // These rows predate this logic (already 'paid' but missing entitlement
  // fields). They are repaired deterministically and NEVER given a fresh
  // month: the expiry is derived from the ORIGINAL paid_at, so repairing
  // cannot be used as a way to extend access.
  if (!row.token) {
    await env.DB.prepare(
      `UPDATE payments SET token = ? WHERE charge_id = ? AND token IS NULL`
    ).bind(candidateToken, chargeId).run();
    row = await readOrder(env, chargeId);
  }

  if (!row.expires_at) {
    if (row.paid_at) {
      await env.DB.prepare(
        `UPDATE payments
            SET expires_at = datetime(paid_at, '${PLAN.durationModifier}')
          WHERE charge_id = ? AND expires_at IS NULL AND paid_at IS NOT NULL`
      ).bind(chargeId).run();
      row = await readOrder(env, chargeId);
    } else {
      // Paid, but we have no record of WHEN. We refuse to invent a start date,
      // because inventing one would silently hand out a fresh month.
      console.error('entitlement: paid row has neither expires_at nor paid_at — needs manual review');
      return {
        ok: false, status: 409, code: 'ENTITLEMENT_INCOMPLETE',
        error: 'ข้อมูลสิทธิ์ของรายการนี้ไม่สมบูรณ์ กรุณาติดต่อผู้ดูแล'
      };
    }
  }

  if (!row.token) {
    return { ok: false, status: 500, code: 'TOKEN_UNAVAILABLE', error: 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง' };
  }

  return { ok: true, granted, token: row.token, paid_at: row.paid_at, expires_at: row.expires_at };
}

/**
 * Record that a webhook event id has been seen. Returns true the first time
 * and false for every replay, so the caller can drop duplicates cheaply.
 * Relies on the PRIMARY KEY in migrations/004_webhook_events.sql.
 */
/**
 * `webhook_events` records events we FINISHED, never events we merely received.
 *
 * The distinction is the whole point. An earlier version wrote the row on
 * arrival and then did the work: when the work failed, the row was already
 * there, so Stripe's retry of the same event was answered "duplicate ignored"
 * and the payment stayed pending forever with no token. Recording receipt and
 * calling it success is how a paid customer silently gets nothing.
 *
 * So the row is written only after the event has been dealt with, and a present
 * row therefore means "already dealt with" rather than "already seen".
 *
 * This table is an optimisation, not the safety mechanism. Two deliveries of
 * the same event arriving at once will both pass the check and both process —
 * and that is harmless, because grantEntitlementOnce grants once no matter how
 * many callers ask. Correctness lives there; this only keeps replays cheap.
 */
export async function isEventProcessed(env, eventId) {
  const row = await env.DB.prepare(
    `SELECT 1 AS found FROM webhook_events WHERE event_id = ? LIMIT 1`
  ).bind(eventId).first();
  return !!row;
}

export async function markEventProcessed(env, eventId, eventType) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO webhook_events (event_id, event_type, received_at)
     VALUES (?, ?, datetime('now'))`
  ).bind(eventId, eventType || null).run();
}

export async function fetchPaymentIntent(env, chargeId) {
  const res = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(chargeId)}`, {
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` }
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, data };
}
