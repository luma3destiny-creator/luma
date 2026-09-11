// functions/api/preview.js — Cloudflare Pages Function

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

  const { name, birthDate, birthTime, province, gender, astroData } = body;

  if (!name || !birthDate || !birthTime || !province || !gender) {
    return json({ error: 'ข้อมูลไม่ครบ' }, 400);
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
    if (t.sunSign) parts.push('ราศีอาทิตย์ (โหราศาสตร์ไทย): ' + t.sunSign);
    if (w.sunSign) parts.push('ราศีอาทิตย์สากล: ' + w.sunSign);
    if (w.ascSign) parts.push('ราศีลัคนาสากล: ' + w.ascSign);
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

เขียนเฉพาะส่วน "บุคลิกภาพและพลังงานชีวิต" ของคนนี้ เป็นภาษาไทย 3-4 ประโยค อ่านง่าย ราวกับนักโหราศาสตร์นั่งคุยด้วยตรงๆ อ้างอิงข้อมูลดาวด้านบนให้ชัดเจน บอกตรงๆ ทั้งจุดแข็งและจุดที่ต้องระวัง ห้ามใช้เครื่องหมาย # หรือ * หรือ - เด็ดขาด ใช้ตัวอักษรธรรมดาเท่านั้น ไม่ต้องใส่หัวข้อ`;

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
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      return json({ error: 'ไม่สามารถเชื่อมต่อ AI ได้' }, 502);
    }

    const claudeData = await claudeRes.json();
    const preview = ((claudeData.content || []).find(function(b){ return b.type === 'text'; }) || {}).text || '';
    return json({ preview });
  } catch (e) {
    return json({ error: 'เกิดข้อผิดพลาด กรุณาลองใหม่' }, 502);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
