// netlify/functions/reading.js
// ตรวจ chargeId ใน Redis → ถ้าผ่าน ลบ token → เรียก Claude → ส่งอีเมลผ่าน Resend

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { name, email, birthDate, birthTime, province, gender, astroData, chargeId } = body;

  if (!name || !birthDate || !birthTime || !province || !gender) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'ข้อมูลไม่ครบ กรุณาระบุชื่อ วันเกิด เวลาเกิด จังหวัด และเพศ' })
    };
  }

  // ─── ตรวจสอบ chargeId ใน Redis ───────────────────────────────────────
  if (!chargeId) {
    return {
      statusCode: 402,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'กรุณาชำระเงินก่อนดูผลดวง' })
    };
  }

  // Dev bypass: chargeId === "dev" ข้ามการตรวจ Redis
  const isDevMode = chargeId === 'dev';

  if (!isDevMode && (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN)) {
    // ถ้าไม่ได้ตั้งค่า Redis ให้ผ่านได้เลย (สำหรับทดสอบ)
    console.warn('Redis not configured — skipping token check');
  } else if (!isDevMode) {
    const key = encodeURIComponent('token:' + chargeId);
    const getUrl = `${process.env.UPSTASH_REDIS_REST_URL}/get/${key}`;

    let tokenValue = null;
    try {
      const getRes = await fetch(getUrl, {
        headers: { 'Authorization': `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
      });
      const getData = await getRes.json();
      tokenValue = getData.result;
    } catch (e) {
      console.error('Redis GET failed:', e);
    }

    if (!tokenValue) {
      return {
        statusCode: 402,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'การชำระเงินยังไม่สำเร็จ กรุณารอสักครู่แล้วลองใหม่' })
      };
    }

    // ลบ token เพื่อให้ใช้ได้ครั้งเดียว
    try {
      const delUrl = `${process.env.UPSTASH_REDIS_REST_URL}/del/${key}`;
      await fetch(delUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
      });
    } catch (e) {
      console.error('Redis DEL failed:', e);
    }
  }

  // ─── สร้าง context จาก astroData ──────────────────────────────────────
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

  // ─── เรียก Claude API ─────────────────────────────────────────────────
  let reading;
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
        max_tokens: 900,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      console.error('Claude API error:', err);
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'ไม่สามารถเชื่อมต่อ AI ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง' })
      };
    }

    const claudeData = await claudeRes.json();
    reading = claudeData.content[0].text;
  } catch (e) {
    console.error('Claude fetch failed:', e);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'เกิดข้อผิดพลาดในการเชื่อมต่อ กรุณาลองใหม่' })
    };
  }

  // ─── ส่งอีเมลผ่าน Resend ─────────────────────────────────────────────
  if (email && process.env.RESEND_API_KEY) {
    try {
      const emailBody = `
<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ผลดวงชะตาของคุณ ${name}</title>
</head>
<body style="margin:0;padding:0;background:#0d0b1a;font-family:'Sarabun',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0b1a;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#1a1630;border-radius:16px;overflow:hidden;max-width:600px;width:100%;">
          <tr>
            <td style="background:linear-gradient(135deg,#1e1540 0%,#2d1f5e 100%);padding:40px 40px 30px;text-align:center;">
              <div style="font-size:36px;margin-bottom:8px;">✨</div>
              <h1 style="color:#ffd97d;font-size:28px;margin:0 0 8px;font-weight:700;letter-spacing:2px;">LUMA</h1>
              <p style="color:#a888ff;font-size:14px;margin:0;letter-spacing:3px;">โหราศาสตร์แห่งดวงดาว</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 40px 16px;">
              <p style="color:#e8e0ff;font-size:17px;margin:0 0 8px;">สวัสดีคุณ <strong style="color:#ffd97d;">${name}</strong></p>
              <p style="color:#9088b0;font-size:14px;margin:0;">นี่คือผลการวิเคราะห์ดวงชะตาของคุณจาก LUMA</p>
              <p style="color:#9088b0;font-size:13px;margin:8px 0 0;">วันเกิด: ${birthDate} | เวลา: ${birthTime} | จังหวัด: ${province}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px;">
              <div style="height:1px;background:linear-gradient(90deg,transparent,#a888ff44,transparent);"></div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 40px 32px;">
              <div style="color:#d4ccf0;font-size:16px;line-height:1.9;white-space:pre-wrap;">${reading}</div>
            </td>
          </tr>
          <tr>
            <td style="background:#13102a;padding:24px 40px;text-align:center;">
              <p style="color:#6b5f8a;font-size:12px;margin:0 0 4px;">LUMA - โหราศาสตร์แห่งดวงดาว</p>
              <p style="color:#4a4060;font-size:11px;margin:0;">อีเมลนี้ส่งโดยอัตโนมัติ กรุณาอย่าตอบกลับ</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
        },
        body: JSON.stringify({
          from: 'LUMA <luma@resend.dev>',
          to: email,
          subject: `✨ ผลดวงชะตาของคุณ ${name} — LUMA`,
          html: emailBody
        })
      });
    } catch (e) {
      console.error('Resend error:', e);
    }
  }

  // ─── ส่งผลลัพธ์กลับ ───────────────────────────────────────────────────
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify({
      reading,
      emailSent: !!(email && process.env.RESEND_API_KEY)
    })
  };
};
