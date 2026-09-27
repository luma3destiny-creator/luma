// Verifies app.html's member-profile pre-fill script — extracted straight out of the
// real shipped file (never a hand-copied duplicate) — against the exact field
// contract #birthForm's calculation code reads: #bday/#bmonth/#byear as plain integer
// option values, #bhour/#bminute as 0-23/0-59 integers, #bplace as an option whose
// VALUE is the place name (matching option required for lat/lng/tz), #bgender as
// 'm'/'f', #bname as the display name. Also covers: anonymous visitor (untouched),
// signed-in member with no profile yet (notice + link to /member), and a saved
// profile whose free-text place has no matching #bplace option (must not silently
// pick the wrong place).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const appHtml = readFileSync(path.join(here, '..', '..', 'app.html'), 'utf8');

function extractPrefillScript(html) {
  const marker = '// Member profile pre-fill for the reading form';
  const start = html.indexOf('<script>\n' + marker);
  assert.ok(start !== -1, 'prefill script marker not found in app.html');
  const openTagLen = '<script>'.length;
  const end = html.indexOf('</script>', start);
  assert.ok(end !== -1, 'closing </script> for prefill script not found');
  return html.slice(start + openTagLen, end);
}

const prefillSrc = extractPrefillScript(appHtml);

// --- minimal DOM stub: only what this script touches -----------------------------
class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.id = '';
    this.style = {};
    this._innerHTML = '';
    this.children = [];
    this.parentNode = null;
    this.value = '';
  }
  set innerHTML(v) { this._innerHTML = v; }
  get innerHTML() { return this._innerHTML; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return this.parentNode.children[i + 1] || null;
  }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  insertBefore(node, ref) {
    node.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i === -1) this.children.push(node); else this.children.splice(i, 0, node);
    return node;
  }
  closest() { return this._closestTarget || null; }
}

class FakeSelect extends FakeEl {
  constructor(tag, options) {
    super(tag);
    this.options = (options || []).map(o => ({ value: String(o), textContent: String(o) }));
    this.selectedIndex = this.options.length ? 0 : -1;
  }
  get value() { return this.selectedIndex >= 0 && this.options[this.selectedIndex] ? this.options[this.selectedIndex].value : ''; }
  set value(v) {
    if (!this.options) return; // base FakeEl constructor sets this.value='' before options exists
    const i = this.options.findIndex(o => String(o.value) === String(v));
    this.selectedIndex = i; // matches real <select>.value= semantics: no match -> -1 (unselected)
  }
}

function buildDom() {
  const registry = {};
  const form = new FakeEl('form'); form.id = 'birthForm';
  const formParent = new FakeEl('section'); formParent.appendChild(form);
  // bhourRow/placeRow are declared below and appended into #birthForm right after
  // creation, mirroring the real page (both field-rows live inside the form), so
  // addNoticeAfter's insertBefore(afterEl.parentNode, ...) has a real parent to use.
  const bname = new FakeEl('input'); bname.id = 'bname'; bname.value = '';
  const bday = new FakeSelect('select', Array.from({ length: 31 }, (_, i) => i + 1)); bday.id = 'bday';
  const bmonth = new FakeSelect('select', Array.from({ length: 12 }, (_, i) => i + 1)); bmonth.id = 'bmonth';
  const byear = new FakeSelect('select', Array.from({ length: 127 }, (_, i) => 2026 - i)); byear.id = 'byear';
  const bhourRow = new FakeEl('div'); form.appendChild(bhourRow);
  const bhour = new FakeSelect('select', Array.from({ length: 24 }, (_, i) => i)); bhour.id = 'bhour';
  bhour._closestTarget = bhourRow;
  const bminute = new FakeSelect('select', Array.from({ length: 60 }, (_, i) => i)); bminute.id = 'bminute';
  const bgender = new FakeSelect('select', ['m', 'f']); bgender.id = 'bgender';
  const placeRow = new FakeEl('div'); form.appendChild(placeRow);
  const bplace = new FakeSelect('select', ['กรุงเทพมหานคร', 'เชียงใหม่', 'ภูเก็ต']); bplace.id = 'bplace';
  bplace._closestTarget = placeRow;
  bplace.selectedIndex = 0; // real page always leaves the freshly-populated select on its first option

  [form, formParent, bname, bday, bmonth, byear, bhourRow, bhour, bminute, bgender, placeRow, bplace]
    .forEach(el => { if (el.id) registry[el.id] = el; });

  const document = {
    getElementById: id => registry[id] || null,
    createElement: tag => new FakeEl(tag),
  };
  return { document, form, bname, bday, bmonth, byear, bhour, bminute, bgender, bplace, formParent, registry };
}

function runPrefill({ meResponse, profileResponse }) {
  const dom = buildDom();
  const calls = [];
  const fetchMock = async (url) => {
    calls.push(url);
    if (url === '/api/auth/me') {
      return { ok: true, json: async () => meResponse };
    }
    if (url === '/api/member/profile') {
      return { ok: true, json: async () => profileResponse };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  // Stand-in for the real page's own #bday rebuild (Q), re-implemented from the exact
  // logic read out of app.html: recompute days-in-month for the current byear/bmonth
  // and rebuild #bday's options, clamping the previously-selected day.
  const Qstub = () => {
    const y = parseInt(dom.byear.value, 10) || 2000;
    const m = parseInt(dom.bmonth.value, 10) || 1;
    const max = new Date(y, m, 0).getDate();
    const prev = parseInt(dom.bday.value, 10) || 1;
    dom.bday.options = Array.from({ length: max }, (_, i) => ({ value: i + 1, textContent: i + 1 }));
    dom.bday.value = Math.min(prev, max);
  };
  const sandbox = {
    document: dom.document,
    window: { Q: Qstub },
    fetch: fetchMock,
    console,
    Number,
    String,
    Boolean,
  };
  vm.createContext(sandbox);
  vm.runInContext(prefillSrc, sandbox);
  return { dom, calls };
}

async function flush() { await new Promise(r => setTimeout(r, 30)); }

test('anonymous visitor: no fetch beyond /api/auth/me, form completely untouched', async () => {
  const { dom, calls } = runPrefill({ meResponse: { ok: true, signedIn: false }, profileResponse: null });
  await flush();
  assert.deepEqual(calls, ['/api/auth/me']);
  assert.equal(dom.bname.value, '');
  assert.equal(dom.formParent.children.length, 1, 'no notice inserted before the form');
});

test('membership system unavailable (e.g. Production): /api/auth/me failing leaves the form untouched', async () => {
  const dom0 = buildDom();
  const fetchMock = async () => ({ ok: false, json: async () => ({}) });
  const sandbox = { document: dom0.document, window: {}, fetch: fetchMock, console, Number, String, Boolean };
  vm.createContext(sandbox);
  vm.runInContext(prefillSrc, sandbox);
  await flush();
  assert.equal(dom0.bname.value, '');
});

test('signed-in member with no profile yet: shows a link to /member, form fields untouched', async () => {
  const { dom } = runPrefill({ meResponse: { ok: true, signedIn: true }, profileResponse: { ok: true, profile: null } });
  await flush();
  assert.equal(dom.bname.value, '');
  assert.equal(dom.formParent.children.length, 2, 'a notice was inserted before the form');
  const notice = dom.formParent.children[0];
  assert.match(notice.innerHTML, /\/member/);
});

test('signed-in member with a complete profile: every field lands in the exact value the calculation reads', async () => {
  const profile = {
    firstName: 'สมชาย', lastName: 'ใจดี',
    birthYear: 1996, birthMonth: 2, birthDay: 29, // leap day — exercises the real days-in-month rebuild
    birthHour: 14, birthMinute: 30,
    birthPlace: 'เชียงใหม่', gender: 'm', timeUnknown: false, updatedAt: 1
  };
  const { dom } = runPrefill({ meResponse: { ok: true, signedIn: true }, profileResponse: { ok: true, profile } });
  await flush();
  assert.equal(dom.bname.value, 'สมชาย ใจดี');
  assert.equal(Number(dom.byear.value), 1996);
  assert.equal(Number(dom.bmonth.value), 2);
  assert.equal(Number(dom.bday.value), 29, 'leap-day 29 Feb 1996 must survive the day-list rebuild');
  assert.equal(Number(dom.bhour.value), 14);
  assert.equal(Number(dom.bminute.value), 30);
  assert.equal(dom.bgender.value, 'm');
  assert.equal(dom.bplace.value, 'เชียงใหม่');
  const selectedOption = dom.bplace.options[dom.bplace.selectedIndex];
  assert.equal(selectedOption.value, 'เชียงใหม่', 'the exact option the calculation reads dataset.lat/lng/tz from');
});

test('profile with timeUnknown: hour/minute forced to 12:00 and an estimate notice is shown', async () => {
  const profile = {
    firstName: null, lastName: null,
    birthYear: 2000, birthMonth: 1, birthDay: 1,
    birthHour: 12, birthMinute: 0,
    birthPlace: 'กรุงเทพมหานคร', gender: 'f', timeUnknown: true, updatedAt: 1
  };
  const { dom } = runPrefill({ meResponse: { ok: true, signedIn: true }, profileResponse: { ok: true, profile } });
  await flush();
  assert.equal(Number(dom.bhour.value), 12);
  assert.equal(Number(dom.bminute.value), 0);
  assert.equal(dom.bname.value, '', 'no name on file: bname is left alone, not overwritten with blank');
  const notice = dom.bhour.closest().nextSibling; // addNoticeAfter inserts the notice as the row's next sibling
  assert.ok(notice, 'estimated-time notice was inserted next to the time fields');
  assert.equal(notice.id, 'memberTimeUnknownNotice');
  assert.match(notice.innerHTML, /12:00/);
});

test('profile place has no matching #bplace option: left unselected (not defaulted to the wrong place) with a notice', async () => {
  const profile = {
    firstName: 'A', lastName: null,
    birthYear: 1990, birthMonth: 6, birthDay: 15,
    birthHour: 8, birthMinute: 5,
    birthPlace: 'บ้านนอก ต.ไม่มีในลิสต์', gender: 'm', timeUnknown: false, updatedAt: 1
  };
  const { dom } = runPrefill({ meResponse: { ok: true, signedIn: true }, profileResponse: { ok: true, profile } });
  await flush();
  assert.equal(dom.bplace.selectedIndex, -1, 'must not silently keep/pick a province that is not the saved one');
  assert.equal(dom.bplace.value, '', 'the form\'s own required-field check will now block submission until the user re-picks');
  const notice = dom.bplace.closest().nextSibling; // addNoticeAfter inserts the notice as the row's next sibling
  assert.ok(notice, 'mismatch notice was inserted next to the place field');
  assert.equal(notice.id, 'memberPlaceMismatchNotice');
  assert.match(notice.innerHTML, /บ้านนอก/);
  // everything else still pre-filled correctly, mismatch is isolated to place only
  assert.equal(Number(dom.byear.value), 1990);
  assert.equal(Number(dom.bday.value), 15);
});

test('in-session prefill never calls POST /api/member/profile (no write-back)', async () => {
  const profile = {
    firstName: 'A', lastName: 'B', birthYear: 1990, birthMonth: 6, birthDay: 15,
    birthHour: 8, birthMinute: 5, birthPlace: 'เชียงใหม่', gender: 'm', timeUnknown: false, updatedAt: 1
  };
  const { calls } = runPrefill({ meResponse: { ok: true, signedIn: true }, profileResponse: { ok: true, profile } });
  await flush();
  assert.deepEqual(calls.sort(), ['/api/auth/me', '/api/member/profile'], 'only reads — never POSTs back to the profile API');
});
