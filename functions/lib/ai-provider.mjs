// functions/lib/ai-provider.mjs — the one door to the AI provider, with a
// Preview-only test mode that never goes through it.
//
// WHY A TEST MODE AT ALL
//
// The quota in ai-quota.mjs has to be exercised on the real Cloudflare stack:
// real D1, real cf-connecting-ip, real routing. Doing that with real AI calls
// spends money on every probe, and a quota test is by definition a lot of
// probes. So a caller who proves they are allowed can ask for the provider
// call -- and ONLY the provider call -- to be replaced by a canned answer.
// Input validation, entitlement checks and the D1 quota reservation are the
// same code as in real use; nothing about them is skipped or simulated.
//
// WHO DECIDES
//
// The SERVER decides, from two variables that exist only where the owner put
// them. A request can only ASK; it can never switch the mode on. All three must
// hold, or a request that asks is refused outright (403) -- before any quota
// is reserved, without a real AI call, and without a canned answer:
//
//   AI_MOCK_ENV     must equal 'preview'. Set it ONLY in the Preview
//                   environment's variables. Nothing a caller sends can set it.
//   AI_MOCK_SECRET  at least 32 characters, set ONLY in Preview, as a Secret.
//                   Never in the frontend, never in Git.
//   header x-luma-ai-mock-key  equal to AI_MOCK_SECRET (compared in constant
//                   time). Only someone holding the secret can send it.
//
// A request that does not send the header is completely unaffected: it takes
// the real path exactly as before. The mode is off unless all three line up.
//
// WHAT A TEST ANSWER LOOKS LIKE
//
// Every canned answer says, in the text itself, that it is test data and not a
// reading, and the JSON response carries "mock": true. Routes that would send
// email do not send it in this mode.

export const AI_MOCK_HEADER = 'x-luma-ai-mock-key';
const MIN_SECRET_LENGTH = 32;
const TEST_LABEL = '[ข้อมูลทดสอบ — ไม่ใช่ผลดวงจริง]';

function timingSafeEqual(a, b) {
  const sa = String(a), sb = String(b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

/**
 * Decide, once per request and before any quota is reserved, how the provider
 * call will be made.
 *   { mode: 'real' }                 no test header: the normal path
 *   { mode: 'mock' }                 test header, and the server allows it
 *   { mode: 'refuse', response }     test header, but the server does not
 */
export function resolveAiMode(env, request) {
  const asked = request && request.headers && request.headers.get
    ? request.headers.get(AI_MOCK_HEADER) : null;
  if (asked === null || asked === undefined) return { mode: 'real' };

  const e = env || {};
  const enabledHere = e.AI_MOCK_ENV === 'preview';
  const secret = typeof e.AI_MOCK_SECRET === 'string' ? e.AI_MOCK_SECRET : '';
  const secretUsable = secret.length >= MIN_SECRET_LENGTH;

  if (enabledHere && secretUsable && timingSafeEqual(asked, secret)) return { mode: 'mock' };

  // Deliberately one answer for every reason -- wrong environment, no secret,
  // wrong secret -- so the response does not tell a prober which it was.
  console.warn('ai-provider: test mode requested but not permitted here');
  return {
    mode: 'refuse',
    response: new Response(JSON.stringify({ ok: false, error: 'ไม่อนุญาตโหมดทดสอบ', code: 'AI_MOCK_FORBIDDEN' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })
  };
}

/**
 * Make the provider call -- or, in test mode, return a canned response of the
 * same shape without touching the network. `route` picks the canned shape.
 */
export async function callAiProvider(aiMode, route, init) {
  if (!aiMode || aiMode.mode !== 'mock') {
    return fetch('https://api.anthropic.com/v1/messages', init);
  }
  return new Response(JSON.stringify({ content: [{ type: 'text', text: mockText(route) }] }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}

function mockText(route) {
  const L = TEST_LABEL;
  switch (route) {
    case 'generate-reading':
    case 'generate-reading-1':
      return JSON.stringify({
        career: L + ' งาน', money: L + ' เงิน', health: L + ' สมดุลชีวิต',
        love: L + ' ความรัก', spirit: L + ' จิตวิญญาณ',
        summary: { highlight: L, watch: L, action: L }
      });
    case 'analyze-vision':
      return JSON.stringify({
        overall: L, key_points: [L], forehead: L, eyes: L, nose: L, mouth: L,
        lifeline: L, headline: L, heartline: L, fateline: L,
        personality: [L], habits: [L], life_trend: [L], strengths: [L],
        warnings: [L], life_advice: [L], improve: [L], avoid_habits: [L],
        good_colors: [], avoid_colors: []
      });
    case 'compat':
      return 'ภาพรวมความเข้ากัน:\n' + L + '\n\n===SUMMARY_JSON===\n' +
             JSON.stringify({ highlight: L, watch: L, action: L });
    default:   // preview, reading
      return L;
  }
}
