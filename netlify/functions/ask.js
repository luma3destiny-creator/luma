// netlify/functions/ask.js
// Proxy สำหรับ "ถามดวง" — รับ question + horoscope context → Claude → ส่ง JSON กลับ

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

  const { question, context } = body;

  if (!question || !question.trim()) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'กรุณาพิมพ์คำถาม' })
    };
  }

  // context คือสรุปดวงของผู้ใช้ (ถ้ามี) ส่งมาจาก frontend
  const systemPrompt = context
    ? `คุณเป็นนักโหราศาสตร์ที่เป็นกันเองและเชี่ยวชาญ ข้อมูลดวงชะตาของผู้ถาม: ${context} ตอบคำถามโดยอ้างอิงข้อมูลดวงนี้ประกอบ ใช้ภาษาไทยที่อบอุ่น เข้าใจง่าย ตอบตรงประเด็น ห้ามใช้ # * - เด็ดขาด`
    : `คุณเป็นนักโหราศาสตร์ที่เป็นกันเองและเชี่ยวชาญ ตอบคำถามด้านโหราศาสตร์เป็นภาษาไทยที่อบอุ่น เข้าใจง่าย ตรงประเด็น ห้ามใช้ # * - เด็ดขาด`;

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: question.trim() }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      console.error('Claude API error:', err);
      return {
        statusCode: 502,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'ไม่สามารถเชื่อมต่อ AI ได้ในขณะนี้' })
      };
    }

    const data = await claudeRes.json();
    const answer = data.content[0].text;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ answer })
    };
  } catch (e) {
    console.error('ask function error:', e);
    return {
      statusCode: 502,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง' })
    };
  }
};
