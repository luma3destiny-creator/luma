// One request, in its own OS process, through a REAL route handler, against a
// shared REAL SQLite file. The AI provider is a stub: it never leaves this
// machine, costs nothing, and counts how many times it was reached.
import fs from 'node:fs';
import { openD1 } from '../otp-concurrency/d1.mjs';
import { onRequestPost as generateReading }  from '../../functions/api/generate-reading.js';
import { onRequestPost as generateReading1 } from '../../functions/api/generate-reading-1.js';
import { onRequestPost as preview }          from '../../functions/api/preview.js';
import { onRequestPost as reading }          from '../../functions/api/reading.js';
import { onRequestPost as compat }           from '../../functions/api/compat.js';
import { onRequestPost as vision }           from '../../functions/api/analyze-vision.js';

const ROUTES = {
  'generate-reading': generateReading, 'generate-reading-1': generateReading1,
  'preview': preview, 'reading': reading, 'compat': compat, 'analyze-vision': vision
};

const [, , dbFile, route, bodyFile, ip] = process.argv;

// ── the stub provider ───────────────────────────────────────────────────────
let aiCalls = 0;
const MOCK = process.env.MOCK_AI || 'ok';
const MOCK_TEXT = JSON.stringify({ career: 'ก', money: 'ข', health: 'ค', love: 'ง', spirit: 'จ',
  summary: { highlight: 'h', watch: 'w', action: 'a' } });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://api.anthropic.com/')) {
    aiCalls++;
    if (MOCK === 'throw') throw new Error('simulated timeout / network error');
    if (MOCK === 'error') return new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 529 });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: MOCK_TEXT }] }), { status: 200 });
  }
  // the legacy /api/reading entitlement store, stubbed so that route can be exercised
  if (u.startsWith('https://upstash.mock/')) {
    return new Response(JSON.stringify({ result: u.includes('/get/') ? 'paid-marker' : 1 }), { status: 200 });
  }
  throw new Error('unexpected outbound request in test: ' + u);
};

// ── the database, optionally broken on purpose ──────────────────────────────
let { DB } = openD1(dbFile);
if (process.env.FAIL_DB === 'all') {
  DB = { prepare() { throw new Error('simulated database outage'); } };
}

const env = { DB };
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('AI_QUOTA_') || k === 'ANTHROPIC_API_KEY' || k.startsWith('UPSTASH_')) env[k] = v;
}
if (process.env.NO_API_KEY === '1') delete env.ANTHROPIC_API_KEY;
if (process.env.NO_IP_SECRET === '1') delete env.AI_QUOTA_IP_SECRET;

console.log = () => {}; console.error = () => {}; console.warn = () => {};

const headers = { 'content-type': 'application/json' };
if (ip && ip !== '-') headers['cf-connecting-ip'] = ip;
const request = new Request('https://luma.test/api/' + route, {
  method: 'POST', headers, body: fs.readFileSync(bodyFile)
});

// START BARRIER. Spawning a process and importing the handlers takes long
// enough that requests launched "together" would otherwise run one after
// another and never actually collide -- a race test that cannot fail. Every
// worker finishes its setup, then waits for the same wall-clock instant.
const startAt = Number(process.env.START_AT || 0);
if (startAt) await new Promise(r => setTimeout(r, Math.max(0, startAt - Date.now())));

let out;
try {
  const res = await ROUTES[route]({ request, env });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  out = { status: res.status, body, retryAfter: res.headers.get('retry-after'), aiCalls };
} catch (e) {
  out = { status: 'threw', error: String(e && e.message || e), aiCalls };
}
process.stdout.write(JSON.stringify(out));
