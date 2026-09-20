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

// ── Claude answered, but the text around the JSON varies ─────────────────────
// Real handler, stub provider (counted, never leaves this machine), in-memory
// quota stub. Nothing here calls the real AI.
const FIVE={career:'งาน {วางแผน}',money:'เงิน "ออม" ก่อน',health:'พัก',love:'รัก',spirit:'ใจ'};
async function callHandler(text,{stop_reason='end_turn',status=200,rawBody}={}){
  let aiCalls=0; const logs=[];
  const realFetch=globalThis.fetch, realErr=console.error, realLog=console.log;
  globalThis.fetch=async(url)=>{
    if(!String(url).startsWith('https://api.anthropic.com/')) throw new Error('unexpected request '+url);
    aiCalls++;
    return new Response(rawBody ?? JSON.stringify({content:[{type:'text',text}],stop_reason,usage:{input_tokens:900,output_tokens:1600}}),{status});
  };
  console.error=(...a)=>logs.push(a.join(' ')); console.log=(...a)=>logs.push(a.join(' '));
  const stmt={bind(){return stmt;},async run(){return {meta:{changes:1,last_row_id:1}};},async first(){return null;},async all(){return {results:[]};}};
  const env={DB:{prepare:()=>stmt},ANTHROPIC_API_KEY:'stub-key',AI_QUOTA_IP_SECRET:'stub-secret'};
  try{
    const r=await onRequestPost({env,request:new Request('https://local/api/generate-reading',{method:'POST',
      headers:{'content-type':'application/json','cf-connecting-ip':'203.0.113.9'},body:JSON.stringify({personName:'สมชาย',sunSign:'เมษ'})})});
    return {status:r.status,body:await r.json(),aiCalls,logs:logs.join('\n')};
  } finally { globalThis.fetch=realFetch; console.error=realErr; console.log=realLog; }
}
const MSG_CUT='ผลวิเคราะห์ยาวเกินกว่าระบบจะจัดรูปแบบได้ กรุณาลองใหม่อีกครั้ง';
const MSG_BAD='ระบบจัดรูปแบบผลวิเคราะห์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
test('plain JSON answer is accepted',async()=>{
  const r=await callHandler(JSON.stringify({...FIVE,summary:{highlight:'h',watch:'w',action:'a'}}));
  assert.equal(r.status,200); assert.deepEqual(r.body.reading,{...FIVE,summary:{highlight:'h',watch:'w',action:'a'}}); assert.equal(r.aiCalls,1);
});
test('JSON inside a ```json fence is accepted',async()=>{
  const r=await callHandler('```json\n'+JSON.stringify(FIVE,null,2)+'\n```');
  assert.equal(r.status,200); assert.equal(r.body.reading.money,FIVE.money); assert.equal(r.body.reading.summary,null); assert.equal(r.aiCalls,1);
});
test('JSON with a short sentence before and after is accepted, braces and quotes inside text are safe',async()=>{
  const r=await callHandler('นี่คือผลดวงของคุณ {ตามข้อมูล}:\n'+JSON.stringify(FIVE)+'\nหวังว่าจะเป็นประโยชน์ }');
  assert.equal(r.status,200); assert.equal(r.body.reading.career,'งาน {วางแผน}'); assert.equal(r.aiCalls,1);
});
test('unfinished JSON → 502 with the cut-off message, one AI call only',async()=>{
  const r=await callHandler(JSON.stringify(FIVE).slice(0,60));
  assert.equal(r.status,502); assert.equal(r.body.error,MSG_CUT); assert.equal(r.body.code,'AI_OUTPUT_TRUNCATED'); assert.equal(r.aiCalls,1);
});
test('stop_reason max_tokens with an unusable answer → 502 with the cut-off message',async()=>{
  const r=await callHandler('{"career":"งาน","money":"เงิน"}',{stop_reason:'max_tokens'});
  assert.equal(r.status,502); assert.equal(r.body.error,MSG_CUT); assert.equal(r.aiCalls,1);
});
test('unusable format → 502 with the format message; empty topic or no JSON is refused',async()=>{
  for(const text of ['ขออภัย ไม่สามารถตอบได้','{"career":"งาน",}',JSON.stringify({...FIVE,love:'  '}),'']){
    const r=await callHandler(text);
    assert.equal(r.status,502,text); assert.equal(r.body.error,MSG_BAD,text); assert.equal(r.body.code,'AI_OUTPUT_INVALID'); assert.equal(r.aiCalls,1);
  }
  const html=await callHandler(null,{rawBody:'<html>bad gateway</html>'});
  assert.equal(html.status,502); assert.equal(html.body.error,MSG_BAD); assert.equal(html.aiCalls,1);
});
test('the old message is gone and failure logs hold no reading text or user data',async()=>{
  const secret='ข้อความลับของคำทำนาย';
  const r=await callHandler('{"career":"'+secret+'","money":"x"');
  assert.notEqual(r.body.error,'รูปแบบผลไม่ถูกต้อง');
  assert.match(r.logs,/reading_parse_failed/); assert.match(r.logs,/"text_length":\d+/);
  for(const leak of [secret,'สมชาย','เมษ','stub-key']) assert.ok(!r.logs.includes(leak),'log leaked '+leak);
});
test('after a format error the page lets the user press again, which is a new request',async()=>{
  let calls=0;
  const h=harness(async()=>{calls++; return calls===1
    ? new Response(JSON.stringify({ok:false,error:MSG_BAD,code:'AI_OUTPUT_INVALID'}),{status:502})
    : new Response(JSON.stringify({ok:true,reading}));});
  await h.window.loadReading({personName:'retry'});
  assert.equal(h.nodes.careerText.textContent,MSG_BAD); assert.equal(h.window._readingReady,false); assert.equal(calls,1);
  await h.window.loadReading({personName:'retry'});   // the user presses again
  assert.equal(calls,2); assert.equal(h.nodes.careerText.textContent,'งาน'); assert.equal(h.window._readingReady,true);
});
