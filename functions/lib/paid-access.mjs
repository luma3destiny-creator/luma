// Shared authorization for paid AI endpoints. Missing/invalid expiry fails closed.
export async function checkPaidAccess(env, token) {
  if (typeof token !== 'string' || !token.trim() || token.length > 256 || ['dev', 'dev-token'].includes(token.trim())) {
    return { ok: false, status: 402, error: 'กรุณากู้คืนสิทธิ์หรือชำระเงินก่อนใช้งานส่วนนี้' };
  }
  if (!env.DB) return { ok: false, status: 503, error: 'ระบบตรวจสิทธิ์ยังไม่พร้อม กรุณาลองภายหลัง' };
  try {
    const row = await env.DB.prepare("SELECT id FROM payments WHERE token = ? AND status = 'paid' AND datetime(expires_at) > datetime('now') LIMIT 1").bind(token.trim()).first();
    return row ? { ok: true, paymentId: row.id } : { ok: false, status: 402, error: 'สิทธิ์ไม่ถูกต้องหรือหมดอายุ กรุณากู้คืนสิทธิ์' };
  } catch {
    return { ok: false, status: 503, error: 'ระบบตรวจสิทธิ์ยังไม่พร้อม กรุณาลองภายหลัง' };
  }
}
