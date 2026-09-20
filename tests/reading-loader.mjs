import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { onRequestPost } from '../functions/api/generate-reading.js';
const html = readFileSync(new URL('../app.html', import.meta.url), 'utf8');
const source = html.split('// BEGIN reading loader')[1].split('// END reading loader')[0];
function harness(fetch, extra = {}) {
  const nodes = Object.fromEntries(['careerText','moneyText','healthText','loveText','spiritText','bemail'].map(id => [id, {textContent:'',value:''}]));
  let timeout, emails = 0;
  const window = {sendByEmail() { emails++; }};
  const context = vm.createContext({window, document:{getElementById:id=>nodes[id]}, fetch, AbortController, TypeError, setTimeout:fn=>{timeout=fn;return 1;},clearTimeout(){}, ...extra});
  vm.runInContext(source,context);
  return {window,nodes,expire:()=>timeout(),emails:()=>emails};
}
const reading = {career:'งาน',money:'เงิน',health:'พัก',love:'รัก',spirit:'ใจ'};
test('all inline scripts parse',()=>{ for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]); });
test('missing configuration returns a useful error without AI calls',async()=>{
  const r=await onRequestPost({env:{},request:new Request('https://local',{method:'POST',body:'{}'})});
  assert.equal(r.status,503); assert.equal((await r.json()).code,'AI_NOT_CONFIGURED');
});
test('server reason replaces loading across all topics',async()=>{
  const h=harness(async()=>new Response(JSON.stringify({error:'AI ยังไม่พร้อม'}),{status:503}));
  await h.window.loadReading({});
  assert.equal(h.nodes.careerText.textContent,'AI ยังไม่พร้อม'); assert.equal(h.nodes.spiritText.textContent,'AI ยังไม่พร้อม');
  assert.equal(h.window._readingReady,false); assert.equal(h.emails(),0);
});
test('network failure, invalid JSON and incomplete reading all finish loading',async()=>{
  for(const fetch of [async()=>{throw new TypeError('network');},async()=>new Response('<html>'),async()=>new Response(JSON.stringify({ok:true,reading:{career:'only'}}))]) {
    const h=harness(fetch); await h.window.loadReading({});
    assert.notEqual(h.nodes.careerText.textContent,'กำลังวิเคราะห์...'); assert.equal(h.window._readingReady,false);
  }
});
test('timeout displays recovery message',async()=>{
  const h=harness((_,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')))));
  const pending=h.window.loadReading({}); h.expire(); await pending;
  assert.match(h.nodes.careerText.textContent,/นานเกินไป/); assert.equal(h.window._readingReady,false);
});
test('older response cannot overwrite latest result or send a second email',async()=>{
  const resolves=[]; const h=harness(()=>new Promise(resolve=>resolves.push(resolve)));
  h.nodes.bemail.value='test@example.com';
  const first=h.window.loadReading({personName:'first'}); const second=h.window.loadReading({personName:'second'});
  resolves[1](new Response(JSON.stringify({ok:true,reading}))); await second;
  resolves[0](new Response(JSON.stringify({ok:true,reading:{...reading,career:'old'}}))); await first;
  assert.equal(h.nodes.careerText.textContent,'งาน'); assert.equal(h.window._readingReady,true); assert.equal(h.emails(),1);
});
test('same input reuses pending and completed requests without another email',async()=>{
  let calls=0, resolve;
  const h=harness(()=>{calls++; return new Promise(r=>{resolve=r;});});
  h.nodes.bemail.value='test@example.com';
  const first=h.window.loadReading({personName:'same'});
  await h.window.loadReading({personName:'same'});
  assert.equal(calls,1);
  resolve(new Response(JSON.stringify({ok:true,reading}))); await first;
  await h.window.loadReading({personName:'same'});
  assert.equal(calls,1); assert.equal(h.emails(),1); assert.equal(h.window._readingReady,true);
});
test('paid token from localStorage is sent in the body only, never cached or shown',async()=>{
  const sent=[]; const store={luma_token:'tok-secret-123'};
  const h=harness(async(url,opts)=>{sent.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ok:true,reading}));},
                  {localStorage:{getItem:k=>store[k]??null}});
  const payload={personName:'paid'};
  await h.window.loadReading(payload);
  assert.equal(sent[0].token,'tok-secret-123'); assert.equal(sent[0].personName,'paid');
  assert.equal('token' in payload,false);   // the caller's object is not changed
  for(const n of Object.values(h.nodes)) assert.doesNotMatch(String(n.textContent),/tok-secret/);
  // same input again is served from the in-page cache: no second request
  await h.window.loadReading({personName:'paid'}); assert.equal(sent.length,1);
});
test('no token, or localStorage unavailable, sends the request exactly as before',async()=>{
  for(const extra of [{localStorage:{getItem:()=>null}},{localStorage:{getItem(){throw new Error('blocked');}}},{}]){
    const sent=[]; const h=harness(async(url,opts)=>{sent.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ok:true,reading}));},extra);
    await h.window.loadReading({personName:'free'});
    assert.deepEqual(sent[0],{personName:'free'}); assert.equal(h.window._readingReady,true);
  }
});
