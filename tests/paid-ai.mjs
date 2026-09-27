import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openD1 } from './otp-concurrency/d1.mjs';
import { onRequestPost as compat } from '../functions/api/compat.js';
import { onRequestPost as vision } from '../functions/api/analyze-vision.js';
import { randomToken, hash as sha256Hash, nowSeconds, SESSION_COOKIE } from '../functions/lib/member-session.mjs';

const alice = 'member-paid-ai-alice-01';

test('both paid AI handlers require a paid token with a valid future expiry, owned by the signed-in caller',async()=>{
 const {DB,raw}=openD1(':memory:');
 // owner_user_id (migrations/015_payments_owner.sql) must exist here too --
 // checkPaidAccess now ALWAYS requires it set and requires the caller to be
 // signed in as that exact owner (see functions/lib/paid-access.mjs's
 // header) -- there is no anonymous/unowned access left, so the one row
 // that must succeed below ('valid') is bound to a real member and every
 // send() carries that member's session cookie by default.
 raw.exec("CREATE TABLE payments(id INTEGER PRIMARY KEY,token TEXT,status TEXT,expires_at TEXT,owner_user_id TEXT)");
 // Paid AI calls now also need the quota table; without it they refuse (tests/ai-quota covers that).
 raw.exec(readFileSync(new URL('../migrations/009_ai_quota.sql', import.meta.url),'utf8'));
 raw.exec(readFileSync(new URL('../migrations/011_membership_core.sql', import.meta.url),'utf8'));
 raw.prepare('INSERT INTO users(id) VALUES (?)').run(alice);
 const aliceSessionToken = randomToken();
 const now = nowSeconds();
 raw.prepare('INSERT INTO member_sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
   .run(await sha256Hash(aliceSessionToken), alice, now, now + 3600);
 const aliceCookie = `${SESSION_COOKIE}=${aliceSessionToken}`;

 const insert=raw.prepare('INSERT INTO payments(token,status,expires_at,owner_user_id) VALUES(?,?,?,?)');
 for(const [token,status,expiry] of [['valid','paid','2099-01-01'],['expired','paid','2000-01-01'],['missing','paid',null],['bad-date','paid','invalid'],['pending','pending','2099-01-01']]) insert.run(token,status,expiry,alice);
 // An owned row with nobody signed in as its owner -- proves the mandatory
 // session/owner match, not just the token/expiry checks above.
 insert.run('unowned','paid','2099-01-01',null);
 const original=globalThis.fetch; let calls=0;
 globalThis.fetch=async()=>{calls++; return new Response(JSON.stringify({content:[{type:'text',text:'{}'}]}));};
 try {
  for(const handler of [compat,vision]) {
   const send=(token,env={DB},cookie=aliceCookie)=>handler({env,request:new Request('https://local',{method:'POST',headers:cookie?{Cookie:cookie}:{},body:JSON.stringify({token,chargeId:'legacy',person1:{name:'a',birthDate:'2000-01-01'},person2:{name:'b',birthDate:'2000-01-01'},imageBase64:'mock',mode:'face'})})});
   for(const token of [undefined,'dev-token','forged','expired','missing','bad-date','pending']) assert.equal((await send(token)).status,402);
   // The valid, owned row with no session at all, or with a session that
   // does not resolve, must be refused before reaching AI configuration.
   assert.equal((await send('valid',{DB},'')).status,401);
   assert.equal((await send('unowned')).status,401); // owner_user_id NULL is refused even while signed in as SOME account
   assert.equal((await send('valid')).status >= 500,true); // Reaches missing AI configuration, without spending.
   assert.equal((await send('valid',{})).status,503);
   assert.equal((await send('valid',{DB,ANTHROPIC_API_KEY:'mock'})).status,200);
  }
  assert.equal(calls,2);
 } finally {globalThis.fetch=original;raw.close();}
});
