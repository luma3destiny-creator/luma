import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openD1 } from './otp-concurrency/d1.mjs';
import { onRequestPost as compat } from '../functions/api/compat.js';
import { onRequestPost as vision } from '../functions/api/analyze-vision.js';
test('both paid AI handlers require a paid token with a valid future expiry',async()=>{
 const {DB,raw}=openD1(':memory:');
 raw.exec("CREATE TABLE payments(id INTEGER PRIMARY KEY,token TEXT,status TEXT,expires_at TEXT)");
 // Paid AI calls now also need the quota table; without it they refuse (tests/ai-quota covers that).
 raw.exec(readFileSync(new URL('../migrations/009_ai_quota.sql', import.meta.url),'utf8'));
 const insert=raw.prepare('INSERT INTO payments(token,status,expires_at) VALUES(?,?,?)');
 for(const [token,status,expiry] of [['valid','paid','2099-01-01'],['expired','paid','2000-01-01'],['missing','paid',null],['bad-date','paid','invalid'],['pending','pending','2099-01-01']]) insert.run(token,status,expiry);
 const original=globalThis.fetch; let calls=0;
 globalThis.fetch=async()=>{calls++; return new Response(JSON.stringify({content:[{type:'text',text:'{}'}]}));};
 try {
  for(const handler of [compat,vision]) {
   const send=(token,env={DB})=>handler({env,request:new Request('https://local',{method:'POST',body:JSON.stringify({token,chargeId:'legacy',person1:{name:'a',birthDate:'2000-01-01'},person2:{name:'b',birthDate:'2000-01-01'},imageBase64:'mock',mode:'face'})})});
   for(const token of [undefined,'dev-token','forged','expired','missing','bad-date','pending']) assert.equal((await send(token)).status,402);
   assert.equal((await send('valid')).status >= 500,true); // Reaches missing AI configuration, without spending.
   assert.equal((await send('valid',{})).status,503);
   assert.equal((await send('valid',{DB,ANTHROPIC_API_KEY:'mock'})).status,200);
  }
  assert.equal(calls,2);
 } finally {globalThis.fetch=original;raw.close();}
});
