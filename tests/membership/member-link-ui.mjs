// tests/membership/member-link-ui.mjs — client-side "เชื่อมสิทธิ์เดิม" UI in
// member.html, run against the REAL extracted script (never a re-typed
// copy), with mock fetch calls only -- no real SMS, no real DB, no real
// server round trip. Mirrors tests/reading-loader.mjs's harness pattern.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../member.html', import.meta.url), 'utf8');
const source = html.split('// BEGIN link purchase')[1].split('// END link purchase')[0];

test('the link-purchase script block parses on its own', () => {
  new vm.Script(source);
});

function harness(fetchImpl) {
  const nodes = {};
  const mk = (id, extra = {}) => (nodes[id] = { id, value: '', textContent: '', hidden: true, disabled: false, focus() {}, addEventListener(ev, fn) { nodes[id]._handlers = nodes[id]._handlers || {}; nodes[id]._handlers[ev] = fn; }, ...extra });
  mk('linkErr'); mk('linkMsg');
  mk('linkStep1', { hidden: false });
  mk('linkStep2', { hidden: true });
  mk('linkPhone');
  mk('linkCode');
  mk('linkRequestBtn');
  mk('linkConfirmBtn');
  mk('linkResendBtn');
  const document = { getElementById: id => nodes[id] };
  const context = vm.createContext({ document, fetch: fetchImpl, console });
  vm.runInContext(source, context);
  const click = id => nodes[id]._handlers.click();
  return { nodes, click };
}

test('requesting a code hides step 1, shows step 2, and shows the server\'s privacy-preserving message', async () => {
  const calls = [];
  const h = harness(async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return new Response(JSON.stringify({ ok: true, challengeId: 'chal-1', message: 'หากเบอร์นี้มีสิทธิ์ที่ยังไม่ผูกกับบัญชีใด ระบบได้ส่งรหัสยืนยันไปให้แล้ว' }));
  });
  h.nodes.linkPhone.value = '0812345678';
  await h.click('linkRequestBtn');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/member/link-request-otp');
  assert.equal(calls[0].body.phone, '0812345678');
  assert.equal(h.nodes.linkStep1.hidden, true);
  assert.equal(h.nodes.linkStep2.hidden, false);
  assert.equal(h.nodes.linkErr.hidden, true);
  assert.equal(h.nodes.linkMsg.hidden, false);
  assert.match(h.nodes.linkMsg.textContent, /ส่งรหัสยืนยัน/);
});

test('an empty phone number is refused client-side, before any request is sent', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return new Response('{}'); });
  h.nodes.linkPhone.value = '   ';
  await h.click('linkRequestBtn');
  assert.equal(calls, 0);
  assert.equal(h.nodes.linkErr.hidden, false);
  assert.equal(h.nodes.linkStep2.hidden, true);
});

test('a request the server refuses (e.g. throttled) surfaces its own error text, not a generic one', async () => {
  const h = harness(async () => new Response(JSON.stringify({ ok: false, error: 'ขอรหัสถี่เกินไป กรุณาลองใหม่ภายหลัง' }), { status: 429 }));
  h.nodes.linkPhone.value = '0812345678';
  await h.click('linkRequestBtn');
  assert.equal(h.nodes.linkErr.hidden, false);
  assert.equal(h.nodes.linkErr.textContent, 'ขอรหัสถี่เกินไป กรุณาลองใหม่ภายหลัง');
  assert.equal(h.nodes.linkStep2.hidden, true, 'must not advance to the code step on a failed request');
});

test('confirming with the right code shows success and collapses both steps', async () => {
  const h = harness(async (url) => {
    if (url === '/api/member/link-request-otp') return new Response(JSON.stringify({ ok: true, challengeId: 'chal-2', message: 'sent' }));
    return new Response(JSON.stringify({ ok: true }));
  });
  h.nodes.linkPhone.value = '0899999999';
  await h.click('linkRequestBtn');
  h.nodes.linkCode.value = '135790';
  await h.click('linkConfirmBtn');
  assert.equal(h.nodes.linkStep1.hidden, true);
  assert.equal(h.nodes.linkStep2.hidden, true);
  assert.equal(h.nodes.linkMsg.hidden, false);
  assert.match(h.nodes.linkMsg.textContent, /เชื่อมสิทธิ์สำเร็จ/);
});

test('confirming a malformed code is refused client-side before any network call', async () => {
  const h = harness(async (url) => {
    if (url === '/api/member/link-request-otp') return new Response(JSON.stringify({ ok: true, challengeId: 'chal-3', message: 'sent' }));
    throw new Error('confirm must not be called for a malformed code');
  });
  h.nodes.linkPhone.value = '0899999999';
  await h.click('linkRequestBtn');
  h.nodes.linkCode.value = 'abc';
  await h.click('linkConfirmBtn');
  assert.equal(h.nodes.linkErr.hidden, false);
  assert.equal(h.nodes.linkStep2.hidden, false, 'stays on the code step so the user can retry');
});

test('a wrong code shows the server\'s rejection message and stays on the code step for retry', async () => {
  const h = harness(async (url) => {
    if (url === '/api/member/link-request-otp') return new Response(JSON.stringify({ ok: true, challengeId: 'chal-4', message: 'sent' }));
    return new Response(JSON.stringify({ ok: false, error: 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุแล้ว' }), { status: 401 });
  });
  h.nodes.linkPhone.value = '0899999999';
  await h.click('linkRequestBtn');
  h.nodes.linkCode.value = '000000';
  await h.click('linkConfirmBtn');
  assert.equal(h.nodes.linkErr.hidden, false);
  assert.equal(h.nodes.linkErr.textContent, 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุแล้ว');
  assert.equal(h.nodes.linkStep2.hidden, false);
});

test('resend re-sends the request with the same button wiring', async () => {
  let sends = 0;
  const h = harness(async () => { sends++; return new Response(JSON.stringify({ ok: true, challengeId: 'chal-' + sends, message: 'sent' })); });
  h.nodes.linkPhone.value = '0812345678';
  await h.click('linkRequestBtn');
  await h.click('linkResendBtn');
  assert.equal(sends, 2);
});
