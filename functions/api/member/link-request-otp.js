// functions/api/member/link-request-otp.js — RETIRED.
//
// Step 1 of linking an old, pre-membership purchase to a signed-in member
// account. Retired along with phone/OTP recovery: there is no real
// prior-purchase data behind this rollout that still needs an account-link
// path, so the whole legacy-linking flow is being removed rather than kept
// dormant.
//
// This handler is now an unconditional 410: it never checks the caller's
// session, never reads or writes an otp_challenges or payments row, and
// never calls the SMS provider. It does not depend on any environment
// variable to stay closed.

export async function onRequestOptions() {
  return cors(null, 204);
}

export async function onRequestPost() {
  return json({
    ok: false,
    error: 'การเชื่อมสิทธิ์เดิมปิดใช้งานแล้ว กรุณาเข้าสู่ระบบด้วยบัญชี LINE หรือ Google',
    code: 'LINK_PURCHASE_RETIRED'
  }, 410);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
function cors(b, s = 200) {
  return new Response(b, { status: s, headers: {
    'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
}
