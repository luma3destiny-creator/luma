// functions/api/request-otp.js — RETIRED.
//
// Phone-based account recovery has been permanently removed: every
// entitlement is now bound to a signed-in member account (LINE/Google) at
// the moment of purchase (see functions/api/pay.js), so there is no
// "recover access by phone number" case left to serve. There is no real
// prior-purchase data behind this rollout to migrate either, so this is a
// clean retirement rather than a dormant flag.
//
// This handler is now an unconditional 410: it never parses `phone`, never
// reads or writes an otp_challenges row, and never calls the SMS provider.
// Deliberately, it does NOT check OTP_PEPPER, PURCHASE_RECOVERY_DISABLED,
// OTP_RECOVERY_ENABLED, or any other environment variable -- a stale,
// missing, or wrongly-configured env value can never reopen this endpoint,
// because nothing here reads one.

export async function onRequestOptions() {
  return cors(null, 204);
}

export async function onRequestPost() {
  return json({
    ok: false,
    error: 'ระบบกู้คืนสิทธิ์ด้วยเบอร์โทร/OTP ปิดใช้งานแล้ว กรุณาเข้าสู่ระบบด้วยบัญชี LINE หรือ Google',
    code: 'RECOVERY_RETIRED'
  }, 410);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
function cors(b, s = 200) {
  return new Response(b, { status: s, headers: {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
}
