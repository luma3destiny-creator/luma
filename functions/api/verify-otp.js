// functions/api/verify-otp.js — RETIRED.
//
// Step 2 of phone-based recovery, retired for the same reason as
// functions/api/request-otp.js: entitlements are bound to signed-in member
// accounts now, and there is no prior-purchase data this rollout needs to
// preserve a recovery path for.
//
// This handler is now an unconditional 410: it never parses `phone`/`code`/
// `challengeId`, never reads or writes an otp_challenges or payments row,
// and never issues a token. It does NOT check OTP_PEPPER,
// PURCHASE_RECOVERY_DISABLED, or any other environment variable -- nothing
// here reads one, so nothing here can be reopened by a stale or missing
// env value.

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
