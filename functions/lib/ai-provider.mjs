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
// The SERVER decides. A request can only ASK, by sending x-luma-ai-mock-key;
// it can never switch the mode on. Every one of these must hold, or a request
// that asks is refused outright (403) -- before any quota is reserved, without
// a real AI call, and without a canned answer:
//
//   1. The DATABASE this deployment is bound to says it is the preview
//      database and that test mode is on right now: a row in
//      preview_test_switch (migration 010, run ONLY on luma-db-preview) with
//      environment = 'preview' and ai_mock_until in the future.
//      This is the check that makes it Preview-only. Cloudflare binds
//      luma-db-preview to Preview and luma-db to Production, and the D1
//      binding is known to reach Pages Functions at runtime. Production's
//      database has no such table, so a Production deployment fails here even
//      if every variable below were copied into Production by mistake.
//      It is also a switch that covers OLD deployments, which keep whatever
//      variables they were created with: it expires on its own, and setting it
//      back to NULL turns test mode off everywhere at once.
//   2. AI_MOCK_ENV == 'preview'  -- set only in Preview's variables.
//   3. AI_MOCK_SECRET, at least 32 characters -- a Secret, only in Preview.
//      Never in the frontend, never in Git.
//   4. header x-luma-ai-mock-key == AI_MOCK_SECRET, compared in constant time.
//
// Additionally, if CF_PAGES_BRANCH happens to be visible at runtime and names
// the production branch, test mode is refused. That value is documented for
// the build and is NOT relied on to ALLOW anything; it can only deny.
//
// What this still does not prove: that nobody binds luma-db-preview to
// Production, or runs migration 010 against luma-db. Both are explicit
// configuration acts, not something a request or a copied variable can do.
//
// A request that does not send the header is completely unaffected: it takes
// the real path exactly as before. The mode is off unless all of the above
// line up.
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

const PRODUCTION_BRANCH = 'main';

/**
 * Decide, once per request and before any quota is reserved, how the provider
 * call will be made.
 *   { mode: 'real' }                 no test header: the normal path
 *   { mode: 'mock' }                 test header, and every check passes
 *   { mode: 'refuse', response }     test header, and any check fails
 */
export async function resolveAiMode(env, request) {
  const asked = request && request.headers && request.headers.get
    ? request.headers.get(AI_MOCK_HEADER) : null;
  if (asked === null || asked === undefined) return { mode: 'real' };

  const e = env || {};
  const secret = typeof e.AI_MOCK_SECRET === 'string' ? e.AI_MOCK_SECRET : '';
  const variablesAllow =
    e.AI_MOCK_ENV === 'preview' &&
    secret.length >= MIN_SECRET_LENGTH &&
    timingSafeEqual(asked, secret) &&
    e.CF_PAGES_BRANCH !== PRODUCTION_BRANCH;       // deny-only; see header note

  // Only consult the database once the cheap checks pass, and treat any
  // failure to read it -- no binding, no table (Production), outage -- as NO.
  if (variablesAllow && await boundDatabaseAllowsMock(e)) return { mode: 'mock' };

  // One answer for every reason, so the response does not tell a prober which
  // check it failed.
  console.warn('ai-provider: test mode requested but not permitted here');
  return {
    mode: 'refuse',
    response: new Response(JSON.stringify({ ok: false, error: 'ไม่อนุญาตโหมดทดสอบ', code: 'AI_MOCK_FORBIDDEN' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })
  };
}

async function boundDatabaseAllowsMock(env) {
  if (!env.DB) return false;
  try {
    const row = await env.DB.prepare(
      `SELECT 1 AS ok FROM preview_test_switch
        WHERE id = 1 AND environment = 'preview'
          AND ai_mock_until IS NOT NULL AND ai_mock_until > datetime('now')`
    ).first();
    return !!(row && Number(row.ok) === 1);
  } catch {
    return false;   // no such table: this is not the preview database
  }
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
