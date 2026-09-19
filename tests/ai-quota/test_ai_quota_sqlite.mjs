// AI call quota — REAL route handlers, a REAL SQLite file, REAL parallel OS
// processes. The AI provider is a local stub throughout: nothing leaves this
// machine and nothing is billed.
//
// What this proves: that the SQL in functions/lib/ai-quota.mjs holds its limits
// when writers genuinely collide in SQLite, and that every AI route goes
// through it. What it does not prove: anything about Cloudflare D1's own
// scheduling (documented to serialise writes, not measured here), the real
// cf-connecting-ip header on Cloudflare, or the provider's real billing.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openD1 } from '../otp-concurrency/d1.mjs';

// fileURLToPath, not URL.pathname: on Windows the pathname is "/D:/Luma/..."
// and path.join turns it into "D:\D:\Luma\...".
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-aiq-'));
const DBFILE = path.join(TMP, 'aiq.sqlite');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail !== undefined ? '  → ' + detail : '')); }
}

const BASE_ENV = { ANTHROPIC_API_KEY: 'mock-key', AI_QUOTA_IP_SECRET: 'test-ip-secret-not-real' };

// Payments are FIXTURES in a throwaway temp database — never Preview or
// Production. Nothing here is written to a real system.
function freshDb({ quotaTable = true } = {}) {
  for (const f of fs.readdirSync(TMP)) fs.rmSync(path.join(TMP, f), { force: true });
  const { raw } = openD1(DBFILE);
  raw.exec(fs.readFileSync(path.join(HERE, '..', 'otp-concurrency', 'schema.sql'), 'utf8'));
  if (quotaTable) raw.exec(fs.readFileSync(path.join(ROOT, 'migrations', '009_ai_quota.sql'), 'utf8'));
  const ins = raw.prepare(
    `INSERT INTO payments (id, phone, name, charge_id, amount, status, token, paid_at, expires_at)
     VALUES (?, ?, ?, ?, 5900, ?, ?, datetime('now'), ?)`);
  ins.run(1, '0800000001', 'ลูกค้าหนึ่ง', 'pi_a', 'paid', 'tok-A', '2099-01-01 00:00:00');
  ins.run(2, '0800000002', 'ลูกค้าสอง',  'pi_b', 'paid', 'tok-B', '2099-01-01 00:00:00');
  ins.run(3, '0800000003', 'ลูกค้าสาม',  'pi_c', 'pending', 'tok-C', '2099-01-01 00:00:00');
  raw.close();
}
function q(sql, ...args) { const { raw } = openD1(DBFILE); try { return raw.prepare(sql).all(...args); } finally { raw.close(); } }
function rows() { return q(`SELECT * FROM ai_quota_events ORDER BY id`); }

let bodySeq = 0;
function bodyFile(obj) {
  const f = path.join(TMP, 'body-' + (bodySeq++) + '.json');
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return f;
}

const BODIES = {
  'generate-reading':   () => ({ sunSign: 'เมษ', moonSign: 'พฤษภ', personName: 'ทดสอบ' }),
  'generate-reading-1': () => ({ sunSign: 'เมษ', personName: 'ทดสอบ' }),
  'preview':            () => ({ name: 'ทดสอบ', birthDate: '2000-01-01', birthTime: '08:00', province: 'ลำพูน', gender: 'm' }),
  'reading':            () => ({ name: 'ทดสอบ', birthDate: '2000-01-01', birthTime: '08:00', province: 'ลำพูน', gender: 'm', chargeId: 'legacy-charge' }),
  'compat':             (token) => ({ token, person1: { name: 'ก', birthDate: '2000-01-01' }, person2: { name: 'ข', birthDate: '2001-01-01' } }),
  'analyze-vision':     (token) => ({ token, imageBase64: 'aGVsbG8=', mediaType: 'image/png', mode: 'face', personName: 'ทดสอบ' })
};

// Run each request in its own process. All of them boot, open the database and
// build their request, report READY, and wait; only when EVERY one has reported
// does the parent release them together. `overlap` is how many were actually
// held at the gate at the same moment -- the evidence that they collided.
let lastOverlap = 0;
async function burst(specs, env = {}) {
  const children = specs.map(([route, body, ip]) => {
    const child = spawn(process.execPath,
      [path.join(HERE, 'worker.mjs'), DBFILE, route, bodyFile(body), ip || '-'],
      { env: { ...process.env, ...BASE_ENV, ...env, BARRIER: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const ready = new Promise((resolve) => {
      child.stdout.on('data', (d) => { out += d; if (out.includes('READY\n')) resolve(); });
      child.on('exit', resolve);   // never hang the gate on a worker that died
    });
    child.stderr.on('data', (d) => { err += d; });
    const done = new Promise((resolve) => child.on('exit', () => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      if (line) resolve(JSON.parse(line.slice(7)));
      else resolve({ status: 'crashed', error: err.slice(0, 300), aiCalls: 0 });
    }));
    return { child, ready, done, isReady: () => out.includes('READY\n') };
  });
  await Promise.all(children.map((c) => c.ready));
  lastOverlap = children.filter((c) => c.isReady() && c.child.exitCode === null).length;
  for (const c of children) { try { c.child.stdin.write('GO\n'); c.child.stdin.end(); } catch {} }
  return Promise.all(children.map((c) => c.done));
}
const sum = (rs) => rs.reduce((n, r) => n + (r.aiCalls || 0), 0);
const count = (rs, s) => rs.filter(r => r.status === s).length;

console.log('\n--- AI quota: real handlers, real SQLite, parallel processes, stub provider ---\n');

// ── 1. free per-IP cap holds under a burst ─────────────────────────────────
{
  freshDb();
  const rs = await burst(Array.from({ length: 10 }, () => ['generate-reading', BODIES['generate-reading'](), '203.0.113.7']),
                         { AI_QUOTA_FREE_PER_IP: '3' });
  check('10 simultaneous free readings from one IP, limit 3 → exactly 3 reach the AI', sum(rs) === 3, 'ai=' + sum(rs));
  check('…the other 7 get 429', count(rs, 429) === 7, JSON.stringify(rs.map(r => r.status)));
  check('…and exactly 3 slots are recorded', rows().length === 3, 'rows=' + rows().length);
  check('…and all 10 workers were held at the gate together before release', lastOverlap === 10, 'overlap=' + lastOverlap);
}

// ── 2. free global ceiling holds across different IPs ──────────────────────
{
  freshDb();
  const rs = await burst(Array.from({ length: 10 }, (_, i) => ['generate-reading', BODIES['generate-reading'](), '198.51.100.' + (i + 1)]),
                         { AI_QUOTA_FREE_PER_IP: '100', AI_QUOTA_FREE_GLOBAL: '4' });
  check('10 simultaneous free readings from 10 IPs, global limit 4 → exactly 4 reach the AI', sum(rs) === 4, 'ai=' + sum(rs));
}

// ── 3. paid per-payment cap holds under a burst ────────────────────────────
{
  freshDb();
  const rs = await burst(Array.from({ length: 8 }, () => ['compat', BODIES.compat('tok-A')]),
                         { AI_QUOTA_PAID_PER_PAYMENT: '2' });
  check('8 simultaneous couple readings on one payment, limit 2 → exactly 2 reach the AI', sum(rs) === 2, 'ai=' + sum(rs));
  check('…the rest get 429', count(rs, 429) === 6, JSON.stringify(rs.map(r => r.status)));
}

// ── 4. a new token does not reset the paid allowance ───────────────────────
{
  freshDb();
  const env = { AI_QUOTA_PAID_PER_PAYMENT: '2' };
  const first = await burst([['compat', BODIES.compat('tok-A')], ['analyze-vision', BODIES['analyze-vision']('tok-A')]], env);
  check('two paid calls on payment 1 succeed', first.every(r => r.status === 200), JSON.stringify(first.map(r => r.status)));

  // What OTP recovery does: the same payment gets a new token. (Fixture DB.)
  q(`UPDATE payments SET token = 'tok-A-recovered' WHERE id = 1`);
  const after = await burst([['compat', BODIES.compat('tok-A-recovered')]], env);
  check('after the token is replaced, the same payment is still at its limit (429)', after[0].status === 429, 'status=' + after[0].status);
  check('…and the AI was not called', after[0].aiCalls === 0);
  const other = await burst([['compat', BODIES.compat('tok-B')]], env);
  check('a different payment is unaffected', other[0].status === 200, 'status=' + other[0].status);
}

// ── 5. legacy routes share the free limit — no way around it ───────────────
{
  freshDb();
  const env = { AI_QUOTA_FREE_PER_IP: '2', UPSTASH_REDIS_REST_URL: 'https://upstash.mock', UPSTASH_REDIS_REST_TOKEN: 'x' };
  const IP = '203.0.113.50';
  const used = await burst([['generate-reading', BODIES['generate-reading'](), IP], ['generate-reading', BODIES['generate-reading'](), IP]], env);
  check('the free allowance is used up on /api/generate-reading', used.every(r => r.status === 200), JSON.stringify(used.map(r => r.status)));
  for (const route of ['generate-reading-1', 'preview', 'reading']) {
    const r = (await burst([[route, BODIES[route](), IP]], env))[0];
    check(`legacy /api/${route} is refused with 429, not a way around the limit`, r.status === 429, 'status=' + r.status);
    check(`…and /api/${route} did not reach the AI`, r.aiCalls === 0, 'ai=' + r.aiCalls);
  }
}

// ── 6. nothing ready → no AI call ─────────────────────────────────────────
{
  freshDb();
  let r = (await burst([['generate-reading', BODIES['generate-reading'](), '203.0.113.9']], { FAIL_DB: 'all' }))[0];
  check('database down: free reading answers 503 and does NOT call the AI', r.status === 503 && r.aiCalls === 0, JSON.stringify(r));
  r = (await burst([['compat', BODIES.compat('tok-A')]], { FAIL_DB: 'all' }))[0];
  check('database down: couple reading answers 503 and does NOT call the AI', r.status === 503 && r.aiCalls === 0, JSON.stringify(r));

  freshDb({ quotaTable: false });
  r = (await burst([['generate-reading', BODIES['generate-reading'](), '203.0.113.9']]))[0];
  check('quota table missing: free reading answers 503, no AI call', r.status === 503 && r.aiCalls === 0, JSON.stringify(r));
  r = (await burst([['analyze-vision', BODIES['analyze-vision']('tok-A')]]))[0];
  check('quota table missing: face reading answers 503, no AI call', r.status === 503 && r.aiCalls === 0, JSON.stringify(r));

  freshDb();
  r = (await burst([['generate-reading', BODIES['generate-reading'](), '203.0.113.9']], { NO_IP_SECRET: '1' }))[0];
  check('AI_QUOTA_IP_SECRET missing: 503, no AI call', r.status === 503 && r.aiCalls === 0, JSON.stringify(r));
  r = (await burst([['generate-reading', BODIES['generate-reading'](), '-']]))[0];
  check('no Cloudflare client IP: 503, no AI call', r.status === 503 && r.aiCalls === 0, JSON.stringify(r));
  r = (await burst([['generate-reading', BODIES['generate-reading'](), '203.0.113.9']], { AI_QUOTA_FREE_PER_IP: 'five' }))[0];
  check('an unreadable limit value: 503, no AI call (no silent default)', r.status === 503 && r.aiCalls === 0, JSON.stringify(r));
  check('…and none of those left a quota row', rows().length === 0, 'rows=' + rows().length);
}

// ── 7. a failed or timed-out call still counts ─────────────────────────────
{
  freshDb();
  const env = { AI_QUOTA_FREE_PER_IP: '1' };
  const IP = '203.0.113.60';
  const a = (await burst([['generate-reading', BODIES['generate-reading'](), IP]], { ...env, MOCK_AI: 'throw' }))[0];
  check('a call that times out reached the AI once and failed', a.aiCalls === 1 && a.status >= 500, JSON.stringify(a));
  check('…its slot is recorded as outcome unknown (may have been billed)', rows()[0] && rows()[0].outcome === 'unknown', JSON.stringify(rows()));
  const b = (await burst([['generate-reading', BODIES['generate-reading'](), IP]], env))[0];
  check('…and it is NOT given back: the next call is 429', b.status === 429 && b.aiCalls === 0, JSON.stringify(b));

  freshDb();
  const c = (await burst([['compat', BODIES.compat('tok-A')]], { AI_QUOTA_PAID_PER_PAYMENT: '1', MOCK_AI: 'error' }))[0];
  check('a provider error is recorded as provider_error and still counts', c.aiCalls === 1 && rows()[0].outcome === 'provider_error');
  const d = (await burst([['compat', BODIES.compat('tok-A')]], { AI_QUOTA_PAID_PER_PAYMENT: '1' }))[0];
  check('…the next paid call is 429', d.status === 429 && d.aiCalls === 0, JSON.stringify(d));
}

// ── 8. the free reading still needs no payment ─────────────────────────────
{
  freshDb();
  const r = (await burst([['generate-reading', BODIES['generate-reading'](), '203.0.113.70']]))[0];
  check('free 5-area reading with no token at all → 200', r.status === 200 && r.body.ok === true, JSON.stringify(r).slice(0, 200));
}

// ── 9. requests that never reach the AI never reserve ──────────────────────
{
  freshDb();
  const rs = await burst([
    ['generate-reading', { personName: 'x'.repeat(101) }, '203.0.113.80'],   // invalid input
    ['compat', BODIES.compat('forged-token')],                               // no entitlement
    ['compat', BODIES.compat('tok-C')],                                       // pending, not paid
    ['analyze-vision', { ...BODIES['analyze-vision']('tok-A'), mode: 'feet' }] // invalid mode
  ]);
  check('invalid input / no entitlement / wrong mode are rejected',
        rs[0].status === 400 && rs[1].status === 402 && rs[2].status === 402 && rs[3].status === 400,
        JSON.stringify(rs.map(r => r.status)));
  const k = await burst([['generate-reading', BODIES['generate-reading'](), '203.0.113.80'],
                         ['compat', BODIES.compat('tok-A')]], { NO_API_KEY: '1' });
  check('no API key → 503', k.every(r => r.status === 503), JSON.stringify(k.map(r => r.status)));
  check('…none of these reserved a slot or called the AI', rows().length === 0 && sum([...rs, ...k]) === 0,
        'rows=' + rows().length + ' ai=' + sum([...rs, ...k]));
}

// ── 10. oversized input is refused before anything else ─────────────────────
{
  freshDb();
  const huge = { ...BODIES['generate-reading'](), padding: 'x'.repeat(20000) };
  const img = { ...BODIES['analyze-vision']('tok-A'), imageBase64: 'A'.repeat(7 * 1024 * 1024 + 10) };
  const rs = await burst([['generate-reading', huge, '203.0.113.90'], ['analyze-vision', img]]);
  check('an oversized body → 413', rs.every(r => r.status === 413), JSON.stringify(rs.map(r => r.status)));
  check('…no slot and no AI call', rows().length === 0 && sum(rs) === 0);
}

// ── 11. free and paid budgets are separate ─────────────────────────────────
{
  freshDb();
  const env = { AI_QUOTA_FREE_PER_IP: '100', AI_QUOTA_FREE_GLOBAL: '2' };
  await burst(Array.from({ length: 4 }, (_, i) => ['generate-reading', BODIES['generate-reading'](), '192.0.2.' + (i + 1)]), env);
  const paid = (await burst([['compat', BODIES.compat('tok-A')]], env))[0];
  check('exhausting the free ceiling does not block paying customers', paid.status === 200, 'status=' + paid.status);
}

// ── 12. nothing personal is stored ─────────────────────────────────────────
{
  freshDb();
  const IP = '203.0.113.123';
  await burst([['generate-reading', BODIES['generate-reading'](), IP], ['compat', BODIES.compat('tok-A')]]);
  const all = rows();
  const blob = JSON.stringify(all);
  check('quota columns are only bucket, subject, route, time, outcome',
        JSON.stringify(Object.keys(all[0]).sort()) === JSON.stringify(['bucket','created_at','id','outcome','route','subject']));
  check('…the raw IP is not stored', !blob.includes(IP));
  check('…the token is not stored', !blob.includes('tok-A'));
  check('…no name or birth date is stored', !blob.includes('ทดสอบ') && !blob.includes('2000-01-01'));
  check('…the paid row is counted by payment id', all.some(r => r.subject === 'pay:1'));
}

// ── 13. the 429 is readable and is not retried by the server ───────────────
{
  freshDb();
  const IP = '203.0.113.140';
  const rs = await burst([['generate-reading', BODIES['generate-reading'](), IP], ['generate-reading', BODIES['generate-reading'](), IP]],
                         { AI_QUOTA_FREE_PER_IP: '1' });
  const limited = rs.find(r => r.status === 429);
  check('the refused request gets a Thai message', !!limited && /ลองใหม่ภายหลัง/.test(limited.body.error), JSON.stringify(limited));
  check('…a Retry-After header', !!limited && !!limited.retryAfter);
  check('…and the server made no attempt of its own for it', !!limited && limited.aiCalls === 0);
}


// ── 14. a body with no Content-Length is cut off at the cap, not buffered ──
{
  freshDb();
  const big = JSON.stringify({ ...BODIES['generate-reading'](), padding: 'x'.repeat(100 * 1024) });
  const r = (await burst([['generate-reading', big, '203.0.113.150']], { STREAM_BODY: '1' }))[0];
  check('a 100 KB chunked body with no Content-Length → 413', r.status === 413, 'status=' + r.status);
  check('…reading stopped at the cap: at most 9 of ~100 chunks pulled',
        r.chunksPulled > 0 && r.chunksPulled <= 9, 'pulled=' + r.chunksPulled + ' of ' + Math.ceil(r.bodyBytes / 1024));
  check('…no slot and no AI call', rows().length === 0 && r.aiCalls === 0);
  const small = (await burst([['generate-reading', BODIES['generate-reading'](), '203.0.113.151']], { STREAM_BODY: '1' }))[0];
  check('a normal chunked body with no Content-Length still works', small.status === 200, 'status=' + small.status);
}

// ── 15. a non-string mediaType is refused, not a crash ─────────────────────
{
  freshDb();
  const rs = await burst([
    ['analyze-vision', { ...BODIES['analyze-vision']('tok-A'), mediaType: 123 }],
    ['analyze-vision', { ...BODIES['analyze-vision']('tok-A'), mediaType: { x: 1 } }]
  ]);
  check('mediaType as a number or object → 400, not a 500',
        rs.every((r) => r.status === 400), JSON.stringify(rs.map((r) => r.status)));
  check('…no slot and no AI call', rows().length === 0 && sum(rs) === 0);
}

// ── 16. legacy /api/reading: a refusal no longer destroys the paid token ───
{
  const LEG = { UPSTASH_REDIS_REST_URL: 'https://upstash.mock', UPSTASH_REDIS_REST_TOKEN: 'x' };
  freshDb();
  let r = (await burst([['reading', BODIES.reading(), '203.0.113.160']], { ...LEG, NO_API_KEY: '1' }))[0];
  check('no API key → 503, and the one-time token is NOT consumed',
        r.status === 503 && r.redisDeletes === 0 && r.aiCalls === 0, JSON.stringify(r).slice(0, 160));

  freshDb();
  r = (await burst([['reading', BODIES.reading(), '203.0.113.161']], { ...LEG, NO_IP_SECRET: '1' }))[0];
  check('quota system not ready → 503, and the token is NOT consumed',
        r.status === 503 && r.redisDeletes === 0 && r.aiCalls === 0, JSON.stringify(r).slice(0, 160));

  freshDb();
  const IP = '203.0.113.162';
  await burst([['generate-reading', BODIES['generate-reading'](), IP]], { ...LEG, AI_QUOTA_FREE_PER_IP: '1' });
  r = (await burst([['reading', BODIES.reading(), IP]], { ...LEG, AI_QUOTA_FREE_PER_IP: '1' }))[0];
  check('over the quota → 429, and the token is NOT consumed',
        r.status === 429 && r.redisDeletes === 0 && r.aiCalls === 0, JSON.stringify(r).slice(0, 160));

  freshDb();
  r = (await burst([['reading', BODIES.reading(), '203.0.113.163']], LEG))[0];
  check('an accepted request consumes the token exactly once, then calls the AI',
        r.status === 200 && r.redisDeletes === 1 && r.aiCalls === 1, JSON.stringify(r).slice(0, 160));
}


// ════ Preview test mode: the provider call is replaced, nothing else is ══════
// A fake secret that exists only in this test file. The real one lives only in
// Cloudflare's Preview variables.
const TEST_SECRET = 'test-only-mock-secret-0123456789abcdef';
const MOCK_ON = { AI_MOCK_ENV: 'preview', AI_MOCK_SECRET: TEST_SECRET, SEND_MOCK_HEADER: TEST_SECRET };
const isLabelled = (r) => JSON.stringify(r.body).includes('ข้อมูลทดสอบ');

// ── 17. correctly enabled: canned answer, real D1 quota, no provider call ───
{
  freshDb();
  const r = (await burst([['generate-reading', BODIES['generate-reading'](), '203.0.113.170']], MOCK_ON))[0];
  check('test mode: 200 with a canned answer', r.status === 200 && r.body.ok === true, JSON.stringify(r).slice(0, 160));
  check('…marked mock:true and labelled as test data in the text', r.body.mock === true && isLabelled(r));
  check('…and the real provider was NOT called', r.aiCalls === 0, 'ai=' + r.aiCalls);
  const rs = rows();
  check('…but the SAME D1 quota slot was reserved, outcome "mock"',
        rs.length === 1 && rs[0].outcome === 'mock' && rs[0].bucket === 'free', JSON.stringify(rs));
}

// ── 18. the cap holds in test mode exactly as it does for real ─────────────
{
  freshDb();
  const rs = await burst(Array.from({ length: 6 }, () => ['generate-reading', BODIES['generate-reading'](), '203.0.113.171']),
                         { ...MOCK_ON, AI_QUOTA_FREE_PER_IP: '2' });
  check('6 simultaneous test-mode calls, limit 2 → exactly 2 answered, 4 × 429',
        count(rs, 200) === 2 && count(rs, 429) === 4, JSON.stringify(rs.map(r => r.status)));
  check('…2 rows recorded, 0 provider calls', rows().length === 2 && sum(rs) === 0, 'rows=' + rows().length + ' ai=' + sum(rs));
}

// ── 19. asking without permission: refused, nothing real, nothing canned ──
{
  const cases = [
    ['wrong environment (AI_MOCK_ENV unset)',       { AI_MOCK_SECRET: TEST_SECRET, SEND_MOCK_HEADER: TEST_SECRET }],
    ['wrong environment (AI_MOCK_ENV=production)',  { AI_MOCK_ENV: 'production', AI_MOCK_SECRET: TEST_SECRET, SEND_MOCK_HEADER: TEST_SECRET }],
    ['no secret configured on the server',          { AI_MOCK_ENV: 'preview', SEND_MOCK_HEADER: TEST_SECRET }],
    ['secret configured but too short',             { AI_MOCK_ENV: 'preview', AI_MOCK_SECRET: 'short', SEND_MOCK_HEADER: 'short' }],
    ['wrong secret sent',                           { AI_MOCK_ENV: 'preview', AI_MOCK_SECRET: TEST_SECRET, SEND_MOCK_HEADER: TEST_SECRET + 'x' }],
    ['empty header sent',                           { AI_MOCK_ENV: 'preview', AI_MOCK_SECRET: TEST_SECRET, SEND_MOCK_HEADER: '' }],
  ];
  for (const [name, env] of cases) {
    freshDb();
    const rs = await burst([['generate-reading', BODIES['generate-reading'](), '203.0.113.172'],
                            ['compat', BODIES.compat('tok-A')]], env);
    check(name + ': 403 on free and paid routes',
          rs.every(r => r.status === 403), JSON.stringify(rs.map(r => r.status)));
    check('…no real AI call, no canned answer, no quota row',
          sum(rs) === 0 && !rs.some(isLabelled) && rows().length === 0,
          'ai=' + sum(rs) + ' rows=' + rows().length);
  }
}

// ── 20. no header: the real path, untouched, even with test mode enabled ──
{
  freshDb();
  const r = (await burst([['generate-reading', BODIES['generate-reading'](), '203.0.113.173']],
                         { AI_MOCK_ENV: 'preview', AI_MOCK_SECRET: TEST_SECRET }))[0];
  check('without the header, the normal provider path runs (test mode is never the default)',
        r.status === 200 && r.aiCalls === 1 && !r.body.mock, JSON.stringify(r).slice(0, 120));
  check('…and its row is a real one, outcome "ok"', rows()[0] && rows()[0].outcome === 'ok');
}

// ── 21. paid routes: a bad token is refused before any quota ──────────────
{
  freshDb();
  const rs = await burst([['compat', BODIES.compat('not-a-real-token')],
                          ['analyze-vision', BODIES['analyze-vision']('tok-C')]], MOCK_ON);   // tok-C is pending
  check('test mode with an unentitled token → 402 on both paid routes',
        rs.every(r => r.status === 402), JSON.stringify(rs.map(r => r.status)));
  check('…refused BEFORE reserving: no row, no call', rows().length === 0 && sum(rs) === 0);
  const ok = await burst([['compat', BODIES.compat('tok-A')], ['analyze-vision', BODIES['analyze-vision']('tok-A')]], MOCK_ON);
  check('test mode with a paid token → canned answers on both paid routes',
        ok.every(r => r.status === 200 && r.body.mock === true && isLabelled(r)), JSON.stringify(ok.map(r => r.status)));
  check('…counted per payment, outcome "mock", 0 provider calls',
        rows().every(x => x.subject === 'pay:1' && x.outcome === 'mock') && rows().length === 2 && sum(ok) === 0);
}

// ── 22. test mode never sends email ───────────────────────────────────────
{
  const LEG = { UPSTASH_REDIS_REST_URL: 'https://upstash.mock', UPSTASH_REDIS_REST_TOKEN: 'x', RESEND_API_KEY: 'stub' };
  const withEmail = () => ({ ...BODIES.reading(), email: 'someone@example.com' });
  freshDb();
  const real = (await burst([['reading', withEmail(), '203.0.113.174']], LEG))[0];
  check('control: the legacy reading route does email on the real path', real.emailsSent === 1, 'emails=' + real.emailsSent);
  freshDb();
  const mock = (await burst([['reading', withEmail(), '203.0.113.175']], { ...LEG, ...MOCK_ON }))[0];
  check('in test mode it sends NO email', mock.status === 200 && mock.emailsSent === 0 && mock.body.emailSent === false,
        JSON.stringify(mock).slice(0, 160));
  check('…and its answer is labelled test data', mock.body.mock === true && isLabelled(mock));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed   (real handlers, real SQLite file, parallel processes, stub AI provider — 0 real AI calls)\n');
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
