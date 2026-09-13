// functions/api/check-access.js — verify token or phone, return unlock status

export async function onRequestOptions() {
  return cors(null, 204);
}

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!env.DB) return json({ ok: false, error: 'Database not configured' }, 500);

  const url   = new URL(request.url);
  const token = url.searchParams.get('token');
  const phone = url.searchParams.get('phone');

  if (!token && !phone) return json({ ok: false }, 400);

  try {
    if (token) {
      // Verify by token (normal page-load check).
      // NOTE: the hard-coded `if (token === 'dev-token') return ok:true`
      // that used to sit here was a free-access bypass — removed.
      const row = await env.DB.prepare(
        `SELECT id, expires_at FROM payments WHERE token = ? AND status = 'paid' LIMIT 1`
      ).bind(token).first();

      if (!row) return json({ ok: false });
      // Check expiry
      if (row.expires_at && new Date(row.expires_at + 'Z') < new Date()) {
        return json({ ok: false, expired: true });
      }
      return json({ ok: true, expiresAt: row.expires_at });
    }

    if (phone) {
      // ── Phone-only recovery ────────────────────────────────────────────
      // Knowing a phone number is NOT proof of owning it. This path hands a
      // working access token to anyone who can type a customer's number, so
      // it is being replaced by the OTP flow (/api/request-otp then
      // /api/verify-otp), which sends a code to the number on the order.
      //
      // It stays enabled until OTP recovery actually works end to end,
      // because switching it off first would strand paying customers with no
      // way back in. Set OTP_RECOVERY_ENABLED='true' to close it, and only
      // once a real code has been received on a real handset.
      if (env.OTP_RECOVERY_ENABLED === 'true') {
        return json({
          ok: false,
          code: 'USE_OTP_RECOVERY',
          error: 'กรุณายืนยันตัวตนด้วยรหัส OTP ที่ส่งไปยังเบอร์ของคุณ'
        }, 403);
      }

      const normalized = normalizePhone(phone);
      if (!normalized) return json({ ok: false, error: 'เบอร์โทรไม่ถูกต้อง' }, 400);

      const row = await env.DB.prepare(
        `SELECT id, token, expires_at FROM payments WHERE phone = ? AND status = 'paid' ORDER BY paid_at DESC LIMIT 1`
      ).bind(normalized).first();

      if (!row) return json({ ok: false });
      // Check expiry
      if (row.expires_at && new Date(row.expires_at + 'Z') < new Date()) {
        return json({ ok: false, expired: true });
      }

      const newToken = crypto.randomUUID();
      await env.DB.prepare(
        `UPDATE payments SET token = ? WHERE id = ?`
      ).bind(newToken, row.id).run();

      return json({ ok: true, token: newToken, expiresAt: row.expires_at });
    }

  } catch (e) {
    console.error('check-access error:', e);
    return json({ ok: false, error: 'เกิดข้อผิดพลาด' }, 500);
  }
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('0')) return digits;
  if (digits.length === 9) return '0' + digits;
  if (digits.length === 11 && digits.startsWith('66')) return '0' + digits.slice(2);
  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function cors(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
