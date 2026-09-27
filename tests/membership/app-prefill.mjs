// Verifies /app's full client-side flow for signed-in members: the real calculation
// script (extracted verbatim from app.html, never a hand-copied duplicate), the reading
// loader (the paid-adjacent AI narrative call), and the member-gating script that ties
// them together. All three run together in one vm context, exactly as they do on the
// real page, so a submit actually runs LUMA's real astrology calculation — this is what
// lets these tests prove POST /api/generate-reading is never called on page open,
// refresh, or an expired/unavailable cache, only from an explicit click on the AI button,
// without relying on a mocked requestSubmit() that just increments a counter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const appHtml = readFileSync(path.join(here, '..', '..', 'app.html'), 'utf8');

function slice(startMarker, endMarker) {
  const start = appHtml.indexOf(startMarker);
  assert.ok(start !== -1, 'marker not found: ' + startMarker);
  const end = appHtml.indexOf(endMarker, start);
  assert.ok(end !== -1, 'end marker not found after ' + startMarker);
  return appHtml.slice(start, end);
}

// The real calculation engine: one big inline <script> running from just before the
// astrology math helpers through the #birthForm submit handler. Located by the same
// unique submit-listener call every round has anchored on, walking back to that
// <script>'s own opening tag so every var/function it depends on comes along with it.
const submitCallIdx = appHtml.indexOf('_.addEventListener("submit"');
assert.ok(submitCallIdx !== -1, 'submit handler call site not found in app.html');
const calcScriptStart = appHtml.lastIndexOf('<script>', submitCallIdx);
assert.ok(calcScriptStart !== -1, 'could not find the calculation <script> tag');
const calcScriptEnd = appHtml.indexOf('</script>', submitCallIdx);
const calcScript = appHtml.slice(calcScriptStart + '<script>'.length, calcScriptEnd);

const readingLoaderScript = slice('// BEGIN reading loader', '// END reading loader');
const gatingScript = slice('// Signed-in member gating for #birthForm', '</script>');

// The real page declares `A` (77 Thai provinces) and `q` (international cities) inside
// the calculation script itself; running that script for real (below) is what actually
// populates window.A/window.q and #bplace's real <option>s, so isKnownPlace() and the
// place <select> are tested against the exact data the page ships, never a stand-in.

// --- minimal but real-enough DOM ---------------------------------------------------
class AutoEl {
  constructor(id, tag) {
    this.id = id || ''; this.tagName = tag || 'div';
    // Real markup starts every one of these cards/forms with the `hidden` attribute
    // (#birthForm, #memberIntroCard, #memberIncompleteCard, #memberChartHeader all do);
    // default to that here too so a card only ever becomes visible because the gating
    // script explicitly un-hides it, exactly as on the real page.
    this.hidden = true; this.disabled = false;
    this._html = ''; this._text = ''; this._value = '';
    this.style = {}; this.dataset = {}; this.className = '';
    this.children = []; this.options = []; this.selectedIndex = -1;
    this._listeners = {};
    var classes = new Set();
    this.classList = {
      add: function () { for (var i = 0; i < arguments.length; i++) classes.add(arguments[i]); },
      remove: function () { for (var i = 0; i < arguments.length; i++) classes.delete(arguments[i]); },
      toggle: function (c, f) { if (f === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); } else if (f) classes.add(c); else classes.delete(c); },
      contains: function (c) { return classes.has(c); },
    };
  }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = v; }
  get textContent() { return this._text; }
  get value() {
    if (this.options.length) {
      return this.selectedIndex >= 0 && this.options[this.selectedIndex] ? this.options[this.selectedIndex].value : '';
    }
    return this._value;
  }
  set value(v) {
    if (this.options.length) {
      for (let i = 0; i < this.options.length; i++) {
        if (String(this.options[i].value) === String(v)) { this.selectedIndex = i; return; }
      }
      return;
    }
    this._value = v;
  }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener() {}
  dispatchEvent(evt) {
    (this._listeners[evt.type] || []).slice().forEach((fn) => fn(evt));
    return true;
  }
  appendChild(child) {
    this.children.push(child);
    // Mirrors real <select>/<optgroup> flattening: HTMLSelectElement.options includes
    // <option>s nested inside an <optgroup>, so a leaf <option> is pushed directly, and
    // an already-populated container (like the optgroup app.html builds place options
    // into before appending the optgroup itself) has its own leaf options flattened up.
    if (child.tagName === 'option') this.options.push(child);
    else if (Array.isArray(child.options) && child.options.length) child.options.forEach((o) => this.options.push(o));
    return child;
  }
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
  scrollIntoView() {}
  remove() {}
  click() { this.dispatchEvent({ type: 'click' }); }
}
class AutoForm extends AutoEl {
  constructor(id) { super(id, 'form'); this.submitCount = 0; }
  requestSubmit() {
    this.submitCount++;
    this.dispatchEvent({ type: 'submit', preventDefault() {} });
  }
}

function buildDocument() {
  const registry = {};
  registry.birthForm = new AutoForm('birthForm');
  // #bgender's two options are static markup in the real page (<option value="m">/<option
  // value="f">), never built by JS — seed them here the same way, since nothing in the
  // scripts under test would ever populate them otherwise.
  const bgender = new AutoEl('bgender', 'select');
  bgender.options = [{ value: 'm', textContent: 'ชาย' }, { value: 'f', textContent: 'หญิง' }];
  bgender.selectedIndex = 0;
  registry.bgender = bgender;
  const document = {
    getElementById(id) {
      if (!registry[id]) registry[id] = new AutoEl(id);
      return registry[id];
    },
    createElement(tag) { return new AutoEl(null, tag); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    body: new AutoEl('body', 'body'),
  };
  return { document, registry };
}

function makeSessionStorage(opts) {
  opts = opts || {};
  const store = {};
  return {
    getItem(k) { if (opts.throwOnGet) throw new Error('storage unavailable'); return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { if (opts.throwOnSet) throw new Error('storage unavailable'); store[k] = String(v); },
    removeItem(k) { delete store[k]; },
    _dump() { return store; },
  };
}

function buildSandbox({ meResult, meOk = true, profileResult, profileOk = true, sessionStorageImpl }) {
  const { document, registry } = buildDocument();
  const fetchCalls = [];
  const fetchMock = async (url, opts) => {
    fetchCalls.push({ url, method: (opts && opts.method) || 'GET' });
    if (url === '/api/auth/me') return { ok: meOk, json: async () => meResult };
    if (url === '/api/member/profile') return { ok: profileOk, json: async () => profileResult };
    if (url === '/api/auth/logout') return { ok: true, json: async () => ({ ok: true }) };
    if (url === '/api/generate-reading') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          reading: { career: 'career-ai', money: 'money-ai', health: 'health-ai', love: 'love-ai', spirit: 'spirit-ai' },
        }),
      };
    }
    throw new Error('unexpected fetch ' + url);
  };
  const sandbox = {
    document,
    fetch: fetchMock,
    Event: class Event { constructor(type, opts) { this.type = type; Object.assign(this, opts || {}); } },
    console,
    setTimeout,
    clearTimeout,
    AbortController: globalThis.AbortController,
    sessionStorage: sessionStorageImpl || makeSessionStorage(),
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { href: '', pathname: '/app' },
    history: { replaceState() {} },
    alert() {},
    confirm() { return true; },
    URLSearchParams,
    navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node-test' },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  };
  sandbox.window = sandbox; // top-level var/function decls become window.X, like a real page
  vm.createContext(sandbox);
  return { sandbox, document, registry, fetchCalls };
}

function runAllScripts(sandbox) {
  vm.runInContext(calcScript, sandbox);
  vm.runInContext(readingLoaderScript, sandbox);
  vm.runInContext(gatingScript, sandbox);
}

async function flush(n) { for (let i = 0; i < (n || 3); i++) await new Promise((r) => setTimeout(r, 20)); }

const COMPLETE_PROFILE_BASE = {
  firstName: 'สมชาย', lastName: 'ใจดี', birthYear: 1996, birthMonth: 2, birthDay: 29,
  birthHour: 14, birthMinute: 30, gender: 'm', timeUnknown: false,
};

function withKnownPlace(sandbox, extra) {
  const place = sandbox.A[0][0];
  return Object.assign({}, COMPLETE_PROFILE_BASE, { birthPlace: place }, extra || {});
}

test('membership system unavailable (/api/auth/me not ok, e.g. Production): falls back to the original visible form, never touches AI', async () => {
  const { registry, fetchCalls, sandbox } = buildSandbox({ meOk: false, meResult: {} });
  runAllScripts(sandbox);
  await flush();
  assert.equal(registry.birthForm.hidden, false, 'the pre-existing manual form must reappear');
  assert.equal(registry.memberIntroCard.hidden, true);
  assert.equal(registry.memberIncompleteCard.hidden, true);
  assert.equal(fetchCalls.some((c) => c.url === '/api/generate-reading'), false);
});

test('anonymous visitor (signedIn: false): shows the LINE/Google intro card, never fetches a profile or calls AI', async () => {
  const { registry, fetchCalls, sandbox } = buildSandbox({ meResult: { ok: true, signedIn: false } });
  runAllScripts(sandbox);
  await flush();
  assert.equal(registry.memberIntroCard.hidden, false);
  assert.equal(registry.birthForm.hidden, true);
  assert.equal(registry.memberChartHeader.hidden, true);
  assert.deepEqual(fetchCalls.map((c) => c.url), ['/api/auth/me']);
});

test('signed in, no profile yet: sends the member to /member, never auto-submits', async () => {
  const { registry, sandbox } = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile: null } });
  runAllScripts(sandbox);
  await flush();
  assert.equal(registry.memberIncompleteCard.hidden, false);
  assert.equal(registry.birthForm.submitCount, 0);
});

test('signed in, saved place no longer matches this page\'s own place list: treated as incomplete, not guessed', async () => {
  const probe = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile: null } });
  runAllScripts(probe.sandbox);
  await flush();
  const profile = Object.assign({}, COMPLETE_PROFILE_BASE, { birthPlace: 'สถานที่ที่ไม่มีในลิสต์' });
  const { registry, sandbox } = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile } });
  runAllScripts(sandbox);
  await flush();
  assert.equal(registry.memberIncompleteCard.hidden, false);
  assert.match(registry.memberIncompleteMsg.textContent, /สถานที่ที่ไม่มีในลิสต์/);
  assert.equal(registry.birthForm.submitCount, 0, 'must never auto-submit with an unresolved place');
});

test('signed in, profile has no name on file: treated as incomplete rather than silently failing to submit', async () => {
  const probe = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile: null } });
  runAllScripts(probe.sandbox);
  await flush();
  const place = probe.sandbox.A[0][0];
  const profile = Object.assign({}, COMPLETE_PROFILE_BASE, { firstName: null, lastName: null, birthPlace: place });
  const { registry, sandbox } = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile } });
  runAllScripts(sandbox);
  await flush();
  assert.equal(registry.memberIncompleteCard.hidden, false, 'no name on file must not silently freeze the hidden form');
  assert.equal(registry.birthForm.submitCount, 0);
});

test('signed in with a complete, usable profile: auto-fills and auto-submits the real form, shows the header, computes the free chart — but never calls the AI endpoint on its own', async () => {
  const probe = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile: null } });
  runAllScripts(probe.sandbox);
  await flush();
  const profile = withKnownPlace(probe.sandbox);
  const { registry, sandbox, fetchCalls } = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile } });
  runAllScripts(sandbox);
  await flush(6);
  assert.equal(registry.birthForm.hidden, true, 'the form stays hidden even though it was just auto-submitted');
  assert.equal(registry.birthForm.submitCount, 1, 'auto-submitted exactly once');
  assert.equal(registry.memberChartHeader.hidden, false);
  assert.equal(registry.memberChartName.textContent, 'สมชาย ใจดี');
  // The real calculation engine ran: it filled in real astrology output, not a stub.
  assert.ok(registry.westSignTitle.textContent.length > 0, 'the real west-chart calculation must have run');
  assert.ok(registry.careerText.textContent.length > 0, 'life-area placeholder must be set by the real submit handler');
  assert.notEqual(registry.careerText.textContent, 'career-ai', 'must not already contain the AI text — AI was never called');
  // The core requirement: opening the page (auto-view) must never call the paid-adjacent AI endpoint on its own.
  assert.equal(fetchCalls.some((c) => c.url === '/api/generate-reading'), false, 'auto-view must not call /api/generate-reading by itself');
  // The AI button must now be visible/enabled, ready for an explicit click.
  assert.equal(registry.aiReadBtn.hidden, false);
  assert.equal(registry.aiReadBtn.disabled, false);
});

test('clicking the AI button after auto-view calls generate-reading exactly once and fills the life areas', async () => {
  const probe = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile: null } });
  runAllScripts(probe.sandbox);
  await flush();
  const profile = withKnownPlace(probe.sandbox);
  const { registry, sandbox, fetchCalls } = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile } });
  runAllScripts(sandbox);
  await flush(6);
  assert.equal(fetchCalls.filter((c) => c.url === '/api/generate-reading').length, 0);
  registry.aiReadBtn.dispatchEvent({ type: 'click' });
  await flush(6);
  assert.equal(fetchCalls.filter((c) => c.url === '/api/generate-reading').length, 1, 'exactly one AI call from the explicit click');
  assert.equal(registry.careerText.textContent, 'career-ai');
  assert.equal(registry.moneyText.textContent, 'money-ai');
});

test('a page refresh with a fresh (<10min) cached reading for the same account never calls generate-reading again, even without clicking', async () => {
  const shared = makeSessionStorage();
  const meResult = { ok: true, signedIn: true };
  const probe = buildSandbox({ meResult, profileResult: { ok: true, profile: null }, sessionStorageImpl: shared });
  runAllScripts(probe.sandbox);
  await flush();
  const profile = withKnownPlace(probe.sandbox);

  const first = buildSandbox({ meResult, profileResult: { ok: true, profile }, sessionStorageImpl: shared });
  runAllScripts(first.sandbox);
  await flush(6);
  first.registry.aiReadBtn.dispatchEvent({ type: 'click' });
  await flush(6);
  assert.equal(first.fetchCalls.filter((c) => c.url === '/api/generate-reading').length, 1);

  // "Refresh": a brand-new vm/document (as a real page reload would be), same tab's
  // sessionStorage carried over, same account, submitted automatically by auto-view.
  const second = buildSandbox({ meResult, profileResult: { ok: true, profile }, sessionStorageImpl: shared });
  runAllScripts(second.sandbox);
  await flush(6);
  assert.equal(second.fetchCalls.some((c) => c.url === '/api/generate-reading'), false, 'auto-view after refresh must not call AI on its own');
  second.registry.aiReadBtn.dispatchEvent({ type: 'click' });
  await flush(6);
  assert.equal(second.fetchCalls.some((c) => c.url === '/api/generate-reading'), false, 'a fresh cache hit must not re-call the AI endpoint');
  assert.equal(second.registry.careerText.textContent, 'career-ai', 'the cached reading is still rendered from the click');
});

test('an expired (>10min) cache entry does not call generate-reading on its own — only an explicit click does, and it re-fetches', async () => {
  const shared = makeSessionStorage();
  const meResult = { ok: true, signedIn: true };
  const probe = buildSandbox({ meResult, profileResult: { ok: true, profile: null }, sessionStorageImpl: shared });
  runAllScripts(probe.sandbox);
  await flush();
  const profile = withKnownPlace(probe.sandbox);

  const first = buildSandbox({ meResult, profileResult: { ok: true, profile }, sessionStorageImpl: shared });
  runAllScripts(first.sandbox);
  await flush(6);
  first.registry.aiReadBtn.dispatchEvent({ type: 'click' });
  await flush(6);
  assert.equal(first.fetchCalls.filter((c) => c.url === '/api/generate-reading').length, 1);

  // Force the cached entry to look 11 minutes old.
  const dump = shared._dump();
  const cache = JSON.parse(dump.luma_reading_cache_v1);
  Object.keys(cache).forEach((k) => { cache[k].at = Date.now() - 11 * 60 * 1000; });
  dump.luma_reading_cache_v1 = JSON.stringify(cache);

  const second = buildSandbox({ meResult, profileResult: { ok: true, profile }, sessionStorageImpl: shared });
  runAllScripts(second.sandbox);
  await flush(6);
  assert.equal(second.fetchCalls.some((c) => c.url === '/api/generate-reading'), false, 'an expired cache entry must still not trigger an automatic AI call — only a click does');
  second.registry.aiReadBtn.dispatchEvent({ type: 'click' });
  await flush(6);
  assert.equal(second.fetchCalls.filter((c) => c.url === '/api/generate-reading').length, 1, 'the click re-fetches once the cache entry has expired');
});

test('sessionStorage throwing (private mode / storage blocked) still never calls generate-reading automatically', async () => {
  const brokenStorage = makeSessionStorage({ throwOnGet: true, throwOnSet: true });
  const meResult = { ok: true, signedIn: true };
  const probe = buildSandbox({ meResult, profileResult: { ok: true, profile: null }, sessionStorageImpl: brokenStorage });
  runAllScripts(probe.sandbox);
  await flush();
  const profile = withKnownPlace(probe.sandbox);

  const second = buildSandbox({ meResult, profileResult: { ok: true, profile }, sessionStorageImpl: brokenStorage });
  runAllScripts(second.sandbox);
  await flush(6);
  assert.equal(second.fetchCalls.some((c) => c.url === '/api/generate-reading'), false, 'auto-view must not call AI even when the cache backing store is unusable');
  second.registry.aiReadBtn.dispatchEvent({ type: 'click' });
  await flush(6);
  assert.equal(second.fetchCalls.filter((c) => c.url === '/api/generate-reading').length, 1, 'the explicit click must still work when storage is broken, just without caching');
});

test('the reading cache is scoped per account: a different member id in the same tab never sees the previous account\'s cached AI reading', async () => {
  const shared = makeSessionStorage();
  const probe = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile: null } });
  runAllScripts(probe.sandbox);
  const profile = withKnownPlace(probe.sandbox);

  const a = buildSandbox({ meResult: { ok: true, signedIn: true, member: { id: 111 } }, profileResult: { ok: true, profile }, sessionStorageImpl: shared });
  runAllScripts(a.sandbox);
  await flush(6);
  a.registry.aiReadBtn.dispatchEvent({ type: 'click' });
  await flush(6);
  assert.equal(a.fetchCalls.filter((c) => c.url === '/api/generate-reading').length, 1);

  // Same exact payload, but a different account id — must not be served account A's cache.
  const b = buildSandbox({ meResult: { ok: true, signedIn: true, member: { id: 222 } }, profileResult: { ok: true, profile }, sessionStorageImpl: shared });
  runAllScripts(b.sandbox);
  await flush(6);
  b.registry.aiReadBtn.dispatchEvent({ type: 'click' });
  await flush(6);
  assert.equal(b.fetchCalls.filter((c) => c.url === '/api/generate-reading').length, 1, 'account B must fetch its own reading, not reuse account A\'s cache entry');
});

test('logging out clears the cached reading for the next signed-in account in the same tab', async () => {
  const shared = makeSessionStorage();
  const meResult = { ok: true, signedIn: true, member: { id: 333 } };
  const probe = buildSandbox({ meResult, profileResult: { ok: true, profile: null }, sessionStorageImpl: shared });
  runAllScripts(probe.sandbox);
  await flush();
  const profile = withKnownPlace(probe.sandbox);

  const first = buildSandbox({ meResult, profileResult: { ok: true, profile }, sessionStorageImpl: shared });
  runAllScripts(first.sandbox);
  await flush(6);
  first.registry.aiReadBtn.dispatchEvent({ type: 'click' });
  await flush(6);
  assert.equal(first.fetchCalls.filter((c) => c.url === '/api/generate-reading').length, 1);

  first.registry.memberChartLogout.dispatchEvent({ type: 'click' });
  await flush(6);
  const dump = shared._dump();
  assert.equal(dump.luma_reading_cache_v1, undefined, 'logout must clear the per-tab reading cache entirely');
});

test('profile with timeUnknown: header shows the 12:00 estimate note, not a fabricated exact time', async () => {
  const probe = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile: null } });
  runAllScripts(probe.sandbox);
  await flush();
  const place = probe.sandbox.A[0][0];
  const profile = Object.assign({}, COMPLETE_PROFILE_BASE, {
    firstName: 'จันทร์', lastName: null, birthPlace: place, birthHour: 12, birthMinute: 0, gender: 'f', timeUnknown: true,
  });
  const { registry, sandbox } = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile } });
  runAllScripts(sandbox);
  await flush(6);
  assert.match(registry.memberChartBirth.textContent, /~12:00 น\. \(ใช้เวลาเกิดโดยประมาณ\)/);
});

test('profile with an impossible calendar date (Feb 30): treated as incomplete, never auto-submitted from a bad date', async () => {
  const probe = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile: null } });
  runAllScripts(probe.sandbox);
  await flush();
  const profile = withKnownPlace(probe.sandbox, { birthMonth: 2, birthDay: 30 });
  const { registry, sandbox } = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile } });
  runAllScripts(sandbox);
  await flush(6);
  assert.equal(registry.memberIncompleteCard.hidden, false, 'Feb 30 is not a real date and must not reach the form');
  assert.equal(registry.birthForm.submitCount, 0);
});

test('profile with an out-of-range birth hour/minute (and timeUnknown false): treated as incomplete', async () => {
  const probe = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile: null } });
  runAllScripts(probe.sandbox);
  await flush();
  const profile = withKnownPlace(probe.sandbox, { birthHour: 25, birthMinute: 90 });
  const { registry, sandbox } = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile } });
  runAllScripts(sandbox);
  await flush(6);
  assert.equal(registry.memberIncompleteCard.hidden, false, 'an impossible hour/minute must not reach the form');
  assert.equal(registry.birthForm.submitCount, 0);
});

test('profile with timeUnknown=true and a garbage stored hour/minute still counts as complete (the server always stores 12:00 in this case)', async () => {
  const probe = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile: null } });
  runAllScripts(probe.sandbox);
  await flush();
  const profile = withKnownPlace(probe.sandbox, { timeUnknown: true, birthHour: 99, birthMinute: -1 });
  const { registry, sandbox } = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile } });
  runAllScripts(sandbox);
  await flush(6);
  assert.equal(registry.memberChartHeader.hidden, false, 'timeUnknown must skip the hour/minute check entirely, matching the server');
  assert.equal(registry.birthForm.submitCount, 1);
});

test('profile passes isCompleteProfile() but a select cannot represent it (birthYear outside #byear\'s populated 1900..thisYear range): never auto-submits a default value in its place', async () => {
  const probe = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile: null } });
  runAllScripts(probe.sandbox);
  await flush();
  // 1899 is a real calendar date (isCompleteProfile passes) but #byear's own <option>s
  // only go back to 1900 -- applyProfileToForm() must catch this and refuse to fall
  // back to whatever default #byear already held.
  const profile = withKnownPlace(probe.sandbox, { birthYear: 1899, birthMonth: 6, birthDay: 15 });
  const { registry, sandbox } = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile } });
  runAllScripts(sandbox);
  await flush(6);
  assert.equal(registry.memberIncompleteCard.hidden, false, 'a value the form cannot select must route to incomplete, not a silent default');
  assert.match(registry.memberIncompleteMsg.textContent, /ยืนยันข้อมูลอีกครั้ง/);
  assert.equal(registry.birthForm.submitCount, 0, 'must never auto-submit with an unselectable value silently left at its default');
});

test('logout with a failing server response (res.ok false): never clears the cache or navigates away, and surfaces an alert', async () => {
  const shared = makeSessionStorage();
  const meResult = { ok: true, signedIn: true, member: { id: 444 } };
  const probe = buildSandbox({ meResult, profileResult: { ok: true, profile: null }, sessionStorageImpl: shared });
  runAllScripts(probe.sandbox);
  await flush();
  const profile = withKnownPlace(probe.sandbox);

  const { registry, sandbox } = buildSandbox({ meResult, profileResult: { ok: true, profile }, sessionStorageImpl: shared });
  // Override the logout endpoint on this sandbox's fetch to simulate a failed logout.
  const originalFetch = sandbox.fetch;
  sandbox.fetch = async (url, opts) => {
    if (url === '/api/auth/logout') return { ok: false, json: async () => ({ ok: false, error: 'boom' }) };
    return originalFetch(url, opts);
  };
  runAllScripts(sandbox);
  await flush(6);
  registry.aiReadBtn.dispatchEvent({ type: 'click' });
  await flush(6);

  let alerted = '';
  sandbox.alert = (msg) => { alerted = msg; };
  const before = shared._dump().luma_reading_cache_v1;
  assert.ok(before, 'a cache entry should exist before the failed logout attempt');
  registry.memberChartLogout.dispatchEvent({ type: 'click' });
  await flush(6);
  assert.equal(shared._dump().luma_reading_cache_v1, before, 'a failed logout must never clear the cache');
  assert.equal(sandbox.location.href, '', 'a failed logout must never navigate away');
  assert.ok(alerted.length > 0, 'the member must be told logout failed');
  assert.equal(registry.memberChartLogout.disabled, false, 'the button must be re-enabled after a failed attempt so they can retry');
});

test('long AI life-area text renders as a teaser + expandable "อ่านเพิ่มเติม" details block; short text renders plainly', async () => {
  const probe = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile: null } });
  runAllScripts(probe.sandbox);
  await flush();
  const profile = withKnownPlace(probe.sandbox);
  const { registry, sandbox, fetchCalls } = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile } });
  const longText = 'ก'.repeat(150);
  sandbox.fetch = async (url, opts) => {
    fetchCalls.push({ url, method: (opts && opts.method) || 'GET' });
    if (url === '/api/auth/me') return { ok: true, json: async () => ({ ok: true, signedIn: true }) };
    if (url === '/api/member/profile') return { ok: true, json: async () => ({ ok: true, profile }) };
    if (url === '/api/generate-reading') {
      return { ok: true, json: async () => ({ ok: true, reading: { career: longText, money: 'short', health: 'short', love: 'short', spirit: 'short' } }) };
    }
    throw new Error('unexpected fetch ' + url);
  };
  runAllScripts(sandbox);
  await flush(6);
  registry.aiReadBtn.dispatchEvent({ type: 'click' });
  await flush(6);
  assert.match(registry.careerText.innerHTML, /vi-readmore/, 'long text must render inside the reusable expandable block');
  assert.match(registry.careerText.innerHTML, /vi-teaser/);
  assert.equal(registry.moneyText.textContent, 'short', 'short text renders plainly, no expandable wrapper');
});

test('signed in (any profile state): the anonymous-visitor hero (logo/tagline/"กรอกวันเกิดและเวลาเกิด") is shrunk/hidden so member content leads', async () => {
  const { registry, sandbox } = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile: null } });
  runAllScripts(sandbox);
  await flush();
  assert.ok(registry.heroSection.classList.contains('member-view'), 'signed-in visitors get the compact hero');
  assert.ok(registry.heroSub.classList.contains('hero-sub-hidden'), '"กรอกวันเกิดและเวลาเกิด" must not be shown to a signed-in member');
});

test('anonymous visitor: the hero stays in its normal (uncompacted) state', async () => {
  const { sandbox } = buildSandbox({ meResult: { ok: true, signedIn: false } });
  runAllScripts(sandbox);
  await flush();
  // Real markup always has these elements regardless of sign-in state; force the same
  // lazy auto-vivification the stub gives every other id, rather than relying on the
  // gating script (which never touches them on this early-return path) to create them.
  const heroSection = sandbox.document.getElementById('heroSection');
  const heroSub = sandbox.document.getElementById('heroSub');
  assert.equal(heroSection.classList.contains('member-view'), false);
  assert.equal(heroSub.classList.contains('hero-sub-hidden'), false);
});

test('the real free core-identity overview (synOverviewTop) is filled by the calculation itself, mirroring synText -- never fabricated, never left on its loading placeholder', async () => {
  const probe = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile: null } });
  runAllScripts(probe.sandbox);
  await flush();
  const profile = withKnownPlace(probe.sandbox);
  const { registry, sandbox } = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile } });
  runAllScripts(sandbox);
  await flush(6);
  assert.ok(registry.synOverviewTop.textContent.length > 0);
  assert.equal(registry.synOverviewTop.textContent, registry.synText.textContent, 'synOverviewTop must mirror the same computed string synText gets, not a separate invented one');
});

test('share/PDF actions stay hidden until a real AI reading exists, then reveal exactly once the click succeeds', async () => {
  const probe = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile: null } });
  runAllScripts(probe.sandbox);
  await flush();
  const profile = withKnownPlace(probe.sandbox);
  const { registry, sandbox } = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile } });
  runAllScripts(sandbox);
  await flush(6);
  const shareBlock = sandbox.document.getElementById('shareBlock');
  const pdfBtn = sandbox.document.getElementById('pdfDownloadBtn');
  assert.equal(shareBlock.hidden, true, 'must stay hidden through auto-view (no AI reading yet)');
  assert.equal(pdfBtn.hidden, true);
  registry.aiReadBtn.dispatchEvent({ type: 'click' });
  await flush(6);
  assert.equal(shareBlock.hidden, false, 'reveals once the AI reading actually loaded');
  assert.equal(pdfBtn.hidden, false);
});

test('the life-area placeholder before any AI click points at the button\'s real position (above), not "below"', async () => {
  const probe = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile: null } });
  runAllScripts(probe.sandbox);
  await flush();
  const profile = withKnownPlace(probe.sandbox);
  const { registry, sandbox } = buildSandbox({ meResult: { ok: true, signedIn: true }, profileResult: { ok: true, profile } });
  runAllScripts(sandbox);
  await flush(6);
  assert.match(registry.careerText.textContent, /ด้านบน/, 'the AI button is above the life-area cards, the copy must say so');
  assert.doesNotMatch(registry.careerText.textContent, /ด้านล่าง/);
});
