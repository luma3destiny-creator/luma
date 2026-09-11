// netlify/functions/preview.js
// ส่งคืนเฉพาะ "บุคลิกภาพและพลังงานชีวิต" โดยไม่ต้องจ่ายเงิน

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { name, birthDate, birthTime, province, gender, astroData } = body;

  if (!name || !birthDate || !birthTime || !province || !gender) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'ข้อมูลไม่ครบ' })
    };
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
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      console.error('Claude API error:', err);
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'ไม่สามารถเชื่อมต่อ AI ได้' })
      };
    }

    const claudeData = await claudeRes.json();
    const preview = claudeData.content[0].text;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ preview })
    };
  } catch (e) {
    console.error('Preview function error:', e);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'เกิดข้อผิดพลาด กรุณาลองใหม่' })
    };
  }
};
