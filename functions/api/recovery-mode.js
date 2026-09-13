// functions/api/recovery-mode.js — which recovery method is live right now.
//
// This exists so that the browser and the server can never disagree about it.
// Turning OTP on is ONE switch, OTP_RECOVERY_ENABLED, and both sides read it:
//
//   unset / anything else → 'phone'  : the old phone-only recovery still works
//                                      (what Production does today), and the
//                                      OTP endpoints are present but unused.
//   'true'                → 'otp'    : /api/check-access refuses the phone path
//                                      outright, and the browser shows the code
//                                      screen.
//
// That makes the switch safe in both directions of deployment order: the new
// frontend can ship before OTP is configured without stranding anyone, and the
// moment the switch is flipped the phone-only path is closed IN THE BACKEND —
// so an old cached page cannot talk its way back into it.
//
// If this endpoint cannot be reached at all, the frontend assumes 'otp' and
// reports the service as unavailable. Failing closed is the only safe default:
// a network error must never be read as "phone-only is fine".

export async function onRequestGet(context) {
  const { env } = context;
  const mode = env.OTP_RECOVERY_ENABLED === 'true' ? 'otp' : 'phone';
  return new Response(JSON.stringify({ mode }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      // Short, so flipping the switch takes effect in about a minute rather
      // than whenever a cache happens to expire.
      'Cache-Control': 'public, max-age=60'
    }
  });
}
