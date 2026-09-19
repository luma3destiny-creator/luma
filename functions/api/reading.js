// functions/api/reading.js — LEGACY route. The frontend no longer calls it,
// but it is still deployed and reachable, so it counts against the free AI
// quota (per Cloudflare client IP, plus the free ceiling) and cannot be used
// to get around it. It has no payments-table entitlement to count per payment,
// which is why it sits in the free budget. See functions/lib/ai-quota.mjs.
//
// KNOWN GAP, NOT FIXED HERE: this route also sends email through Resend
// directly (below), OUTSIDE the email-send quota that /api/sendmail enforces.
// The AI quota bounds how many readings it can generate, and therefore how
// many of those emails it can send, but it is not an email limit and the
// email cost is not counted anywhere. Retiring this route closes it; that is
// a decision to make once traffic to it is confirmed to be zero.
import { reserveAiCall, recordAiOutcome, quotaResponse, readJsonBody, boundedText } from '../lib/ai-quota.mjs';

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const parsed = await readJsonBody(request, 8 * 1024);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const { name, email, birthDate, birthTime, province, gender, astroData, chargeId } = body;

  if (!name || !birthDate || !birthTime || !province || !gender) {
    return json({ error: 'ข้อมูลไม่ครบ กรุณาระบุชื่อ วันเกิด เวลาเกิด จังหวัด และเพศ' }, 400);
  }
  if (![[name, 100], [email, 254], [birthDate, 20], [birthTime, 10], [province, 100],
        [gender, 5], [chargeId, 200]].every(([v, max]) => boundedText(v, max).ok)) {
    return json({ error: 'ข้อมูลไม่ถูกต้อง' }, 400);
  }

  if (!chargeId) {
    return json({ error: 'กรุณาชำระเงินก่อนดูผลดวง' }, 402);
  }

  // Dev bypass REMOVED (`chargeId === 'dev'` used to skip the check entirely).
  let redisKey = null;   // set once the one-time token has been seen; consumed later
  {
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
      // FAIL CLOSED. This used to `console.warn` and then fall through,
      // which meant that whenever the entitlement store was unconfigured
      // ANY chargeId string unlocked a paid reading. If we cannot prove the
      // request was paid for, we refuse it.
      console.error('entitlement store not configured — denying request');
      return json({ error: 'ระบบตรวจสอบสิทธิ์ไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่ภายหลัง' }, 503);
    } else {
      const key = encodeURIComponent('token:' + chargeId);
      const getUrl = `${env.UPSTASH_REDIS_REST_URL}/get/${key}`;

      let tokenValue = null;
      try {
        const getRes = await fetch(getUrl, {
          headers: { 'Authorization': `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
        });
        const getData = await getRes.json();
        tokenValue = getData.result;
      } catch (e) {
        console.error('Redis GET failed:', e);
      }

      if (!tokenValue) {
        return json({ error: 'การชำระเงินยังไม่สำเร็จ กรุณารอสักครู่แล้วลองใหม่' }, 402);
      }

      // The one-time token is NOT consumed here. It used to be deleted at this
      // point -- before the API key was checked and before a quota slot was
      // reserved -- so a request refused for either reason still destroyed
      // the customer's paid entitlement. It is now consumed only once this
      // request is certain to reach the AI; see consumeRedisToken below.
      redisKey = key;
    }
  }

  const genderText = gender === 'm' ? 'ชาย' : 'หญิง';

  let astroContext = '';
  if (astroData) {
    const b = astroData.bazi || {};
    const t = astroData.thai || {};
    const w = astroData.western || {};
    const parts = [];
    if (b.dmEl) parts.push('ธาตุเจ้าวัน (BaZi Day Master): ' + b.dmEl);
    if (b.dominant) parts.push('ธาตุเด่น: ' + b.dominant);
    if (b.pillars) parts.push('เสาสี่เสา (Four Pillars): ' + b.pillars);
    if (b.daYun) parts.push('ช่วงโชคใหญ่ปัจจุบัน (Da Yun): ' + b.daYun);
    if (b.curDaYunRel) parts.push('ความสัมพันธ์โชคใหญ่กับเจ้าวัน: ' + b.curDaYunRel);
    if (t.sunSign) parts.push('ราศีอาทิตย์ (โหราศาสตร์ไทย): ' + t.sunSign);
    if (t.ascSign) parts.push('ราศีลัคนา (โหราศาสตร์ไทย): ' + t.ascSign);
    if (t.moonSign) parts.push('ราศีจันทร์ (โหราศาสตร์ไทย): ' + t.moonSign);
    if (w.sunSign) parts.push('ราศีอาทิตย์สากล: ' + w.sunSign);
    if (w.moonSign) parts.push('ราศีจันทร์สากล: ' + w.moonSign);
    if (w.ascSign) parts.push('ราศีลัคนาสากล: ' + w.ascSign);
    if (w.sunEl) parts.push('ธาตุอาทิตย์สากล: ' + w.sunEl);
    if (parts.length > 0) {
      astroContext = '\n\nข้อมูลดาวที่คำนวณแล้ว:\n' + parts.join('\n');
    }
  }

  const prompt = `คุณเป็นนักโหราศาสตร์ที่มีประสบการณ์สูง เชี่ยวชาญโหราศาสตร์ไทย ปาจื่อจีน BaZi และโหราศาสตร์สากล

ข้อมูลผู้ขอดูดวง:
ชื่อ: ${name}
วันเกิด: ${birthDate} (รูปแบบ ปี-เดือน-วัน เช่น 1995-11-08 คือ 8 พฤศจิกายน 1995)
เวลาเกิด: ${birthTime}
จังหวัดเกิด: ${province}
เพศ: ${genderText}${astroContext}

เขียนผลดวงเป็นภาษาไทย อ่านง่าย ราวกับนักโหราศาสตร์นั่งคุยด้วยตรงๆ อ้างอิงข้อมูลดาวด้านบนให้ชัดเจน

สำคัญมาก: พูดตรงๆ ทั้งดีและไม่ดี ถ้าช่วงนี้ดวงมีอุปสรรค ความเสี่ยง หรือต้องระวัง ให้บอกตรงๆ พร้อมคำแนะนำว่าควรทำอะไร ห้ามทำให้ดูดีเกินจริงหรือประจบ นักโหราศาสตร์ที่ดีบอกความจริงทั้งสองด้าน

แบ่งเป็น 4 ส่วน แต่ละส่วนขึ้นต้นด้วยชื่อหัวข้อตามด้วยเครื่องหมายทวิภาค จากนั้นขึ้นบรรทัดใหม่เขียนเนื้อหา 3-4 ประโยค แล้วเว้น 1 บรรทัดก่อนหัวข้อถัดไป

หัวข้อ 4 ส่วน:
บุคลิกภาพและพลังงานชีวิต
การงานและการเงิน
ความรักและความสัมพันธ์
สุขภาพและคำแนะนำสำคัญ

ห้ามใช้เครื่องหมาย # หรือ * หรือ - เด็ดขาด ใช้ตัวอักษรธรรมดาเท่านั้น`;

  // This route never checked for the key. Refuse before anything is reserved.
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'AI ยังไม่พร้อม' }, 503);

  const quota = await reserveAiCall(env, { bucket: 'free', route: 'reading', request });
  if (!quota.ok) return quotaResponse(quota);

  // Only now -- key present, slot reserved, the AI is about to be called --
  // is the one-time token spent. Every refusal above leaves it intact.
  //
  // Still not atomic with the check above: two requests racing on the same
  // token can both pass the GET before either DEL. The AI quota bounds what
  // that can cost; making it exact needs GETDEL, which would consume the token
  // before the refusals above, the very thing this change removes.
  if (redisKey) {
    try {
      await fetch(`${env.UPSTASH_REDIS_REST_URL}/del/${redisKey}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
      });
    } catch (e) {
      console.error('Redis DEL failed:', e);
    }
  }

  let reading;
  try {
    let claudeRes;
    try {
      claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 900,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }]
      })
    });
    } catch (e) {
      await recordAiOutcome(env, quota.reservationId, 'unknown');
      throw e;
    }
    await recordAiOutcome(env, quota.reservationId, claudeRes.ok ? 'ok' : 'provider_error');

    if (!claudeRes.ok) {
      return json({ error: 'ไม่สามารถเชื่อมต่อ AI ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง' }, 502);
    }

    const claudeData = await claudeRes.json();
    reading = ((claudeData.content || []).find(function(b){ return b.type === 'text'; }) || {}).text || '';
  } catch (e) {
    return json({ error: 'เกิดข้อผิดพลาดในการเชื่อมต่อ กรุณาลองใหม่' }, 502);
  }

  // ส่งอีเมลผ่าน Resend
  if (email && env.RESEND_API_KEY) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.RESEND_API_KEY}`
        },
        body: JSON.stringify({
          from: 'LUMA <luma@resend.dev>',
          to: email,
          subject: `✨ ผลดวงชะตาของคุณ ${name} — LUMA`,
          html: `<div style="font-family:sans-serif;background:#0d0b1a;color:#e8e0ff;padding:32px;border-radius:12px;white-space:pre-wrap;">${reading}</div>`
        })
      });
    } catch (e) {
      console.error('Resend error:', e);
    }
  }

  return json({ reading, emailSent: !!(email && env.RESEND_API_KEY) });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
