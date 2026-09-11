// functions/api/reading.js — Cloudflare Pages Function

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

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { name, email, birthDate, birthTime, province, gender, astroData, chargeId } = body;

  if (!name || !birthDate || !birthTime || !province || !gender) {
    return json({ error: 'ข้อมูลไม่ครบ กรุณาระบุชื่อ วันเกิด เวลาเกิด จังหวัด และเพศ' }, 400);
  }

  if (!chargeId) {
    return json({ error: 'กรุณาชำระเงินก่อนดูผลดวง' }, 402);
  }

  // Dev bypass
  const isDevMode = chargeId === 'dev';

  if (!isDevMode) {
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
      console.warn('Redis not configured — skipping token check');
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

      // ลบ token ใช้ได้ครั้งเดียว
      try {
        const delUrl = `${env.UPSTASH_REDIS_REST_URL}/del/${key}`;
        await fetch(delUrl, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
        });
      } catch (e) {
        console.error('Redis DEL failed:', e);
      }
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

  let reading;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 900,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      return json({ error: 'ไม่สามารถเชื่อมต่อ AI ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง' }, 502);
    }

    const claudeData = await claudeRes.json();
    reading = claudeData.content[0].text;
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
