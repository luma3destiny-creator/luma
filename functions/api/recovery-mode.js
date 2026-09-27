// functions/api/recovery-mode.js — RETIRED, reports a fixed 'closed' status.
//
// Phone/OTP recovery has been permanently removed (see functions/api/
// request-otp.js, verify-otp.js, and the phone branch of check-access.js).
// This endpoint no longer reads PURCHASE_RECOVERY_DISABLED or
// OTP_RECOVERY_ENABLED to decide what to announce -- there is no live
// recovery method for either of those flags to describe anymore, so
// reading them here would just be a second, redundant way for a stale/
// missing env value to misreport the feature as available. It always
// answers 'closed', unconditionally.
//
// Nothing in the current app.html/member.html calls this endpoint anymore
// (the recovery UI itself is gone), but it is kept, rather than deleted,
// as a safe fixed answer for any client -- a cached old page, an external
// integration -- that still asks.

export async function onRequestGet() {
  return new Response(JSON.stringify({ mode: 'closed' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60'
    }
  });
}
