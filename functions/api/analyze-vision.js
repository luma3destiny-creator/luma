// functions/api/analyze-vision.js — Claude Vision for face & palm reading

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
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { imageBase64, mediaType, mode, personName } = body;
  if (!imageBase64 || !mode) return json({ error: 'ข้อมูลไม่ครบ' }, 400);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'AI ยังไม่พร้อม' }, 500);

  const validTypes = ['image/jpeg','image/png','image/gif','image/webp'];
  const rawType = (mediaType || '').toLowerCase().replace('image/jpg','image/jpeg');
  const safeType = validTypes.includes(rawType) ? rawType : 'image/jpeg';

  const name = personName || 'คุณ';

  const guardrails = `กฎสำคัญ:
- แต่ละหัวข้อควรมีทั้งจุดที่โดดเด่นและสิ่งที่ควรพัฒนา อ้างอิงสิ่งที่เห็นจริงในรูป ไม่ใช่คำเตือนหรือคำทำนายร้ายแรง
- ห้ามระบุชื่อโรค อวัยวะที่มีปัญหา อาการเจ็บป่วย ความเสี่ยงด้านสุขภาพ หรือสภาพจิตใจ/ความผิดปกติทางจิตใดๆ ทั้งสิ้นในทุกหัวข้อ
- ห้ามยืนยันว่าเหตุการณ์ในอนาคตจะเกิดขึ้นแน่นอน หรือฟันธงเรื่องบุคลิก ความสามารถ หรือชะตาชีวิตราวกับเป็นข้อเท็จจริง ให้นำเสนอในเชิงมุมมองความเชื่อดั้งเดิมเพื่อการไตร่ตรองส่วนตัวเท่านั้น
- ใช้ภาษาไทยพูดง่าย เป็นกันเอง เฉพาะเจาะจงกับ "${name}" ไม่ใช่ประโยคที่ใครได้รับก็ได้
- "key_points" ให้ดึงสรุปมาจากเนื้อหาที่เขียนไว้แล้วเท่านั้น ห้ามเพิ่มข้อมูลใหม่ที่ไม่มีในเนื้อหาข้างต้น อย่างมาก 3 ข้อ ข้อละไม่เกิน 15 คำ`;

  const prompts = {
    face: `คุณเป็นผู้เชี่ยวชาญโหงวเฮ้งชาวไทยที่อ่านใบหน้าตามศาสตร์จีนโบราณอย่างตรงไปตรงมา
วิเคราะห์ใบหน้าในรูปสำหรับ "${name}"

${guardrails}

ตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น:
{
  "forehead": "วิเคราะห์หน้าผาก 3-4 ประโยค ทั้งจุดเด่นและสิ่งที่ควรพัฒนา",
  "eyes": "วิเคราะห์ตาและคิ้ว 3-4 ประโยค ทั้งจุดเด่นและสิ่งที่ควรพัฒนา",
  "nose": "วิเคราะห์จมูก 3-4 ประโยค ทั้งจุดเด่นและสิ่งที่ควรพัฒนา",
  "mouth": "วิเคราะห์ปากและคาง 3-4 ประโยค ทั้งจุดเด่นและสิ่งที่ควรพัฒนา",
  "overall": "ภาพรวม 3-4 ประโยค",
  "key_points": ["ประเด็นสำคัญที่ 1", "ประเด็นสำคัญที่ 2", "ประเด็นสำคัญที่ 3"],
  "personality": ["บุคลิกที่ 1 (สั้นกระชับ)", "บุคลิกที่ 2", "บุคลิกที่ 3"],
  "habits": ["นิสัยที่ 1", "นิสัยที่ 2", "นิสัยที่ 3"],
  "life_trend": ["แนวโน้มที่ 1", "แนวโน้มที่ 2", "แนวโน้มที่ 3"],
  "good_colors": [{"hex":"#RRGGBB","name":"ชื่อสีภาษาไทย"},{"hex":"#RRGGBB","name":"ชื่อสีภาษาไทย"}],
  "avoid_colors": [{"hex":"#RRGGBB","name":"ชื่อสีภาษาไทย"},{"hex":"#RRGGBB","name":"ชื่อสีภาษาไทย"}],
  "improve": ["สิ่งที่ควรปรับที่ 1", "สิ่งที่ควรปรับที่ 2", "สิ่งที่ควรปรับที่ 3"],
  "avoid_habits": ["สิ่งที่ควรหลีกเลี่ยงที่ 1", "สิ่งที่ควรหลีกเลี่ยงที่ 2", "สิ่งที่ควรหลีกเลี่ยงที่ 3"]
}`,

    palm: `คุณเป็นผู้เชี่ยวชาญลายมือศาสตร์จีนโบราณที่อ่านฝ่ามืออย่างตรงไปตรงมา
วิเคราะห์ฝ่ามือในรูปสำหรับ "${name}"

${guardrails}

ตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น:
{
  "lifeline": "วิเคราะห์เส้นชีวิต 3-4 ประโยค ทั้งจุดเด่นและสิ่งที่ควรพัฒนา",
  "headline": "วิเคราะห์เส้นสมอง 3-4 ประโยค ทั้งจุดเด่นและสิ่งที่ควรพัฒนา",
  "heartline": "วิเคราะห์เส้นจิตใจ 3-4 ประโยค ทั้งจุดเด่นและสิ่งที่ควรพัฒนา",
  "fateline": "วิเคราะห์เส้นวาสนา 3-4 ประโยค ทั้งจุดเด่นและสิ่งที่ควรพัฒนา",
  "overall": "ภาพรวม 3-4 ประโยค",
  "key_points": ["ประเด็นสำคัญที่ 1", "ประเด็นสำคัญที่ 2", "ประเด็นสำคัญที่ 3"],
  "personality": ["บุคลิกที่ 1 (สั้นกระชับ)", "บุคลิกที่ 2", "บุคลิกที่ 3"],
  "strengths": ["จุดแข็งที่ 1", "จุดแข็งที่ 2", "จุดแข็งที่ 3"],
  "warnings": ["สิ่งที่ควรระวังในเชิงพฤติกรรมที่ 1", "สิ่งที่ควรระวังในเชิงพฤติกรรมที่ 2", "สิ่งที่ควรระวังในเชิงพฤติกรรมที่ 3"],
  "life_advice": ["คำแนะนำที่ 1", "คำแนะนำที่ 2", "คำแนะนำที่ 3"]
}`
  };

  const prompt = prompts[mode];
  if (!prompt) return json({ error: 'mode ไม่ถูกต้อง' }, 400);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 3000,
        thinking: { type: 'disabled' },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: safeType, data: imageBase64 } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    const data = await res.json();
    if (!res.ok) {
      const errMsg = data?.error?.message || JSON.stringify(data);
      console.error('Claude API error:', errMsg);
      return json({ error: 'API Error: ' + errMsg }, 502);
    }

    const textBlock = (data.content || []).find(function(b){ return b.type === 'text'; });
    const rawText = (textBlock && textBlock.text ? textBlock.text : '').trim();
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return json({ error: 'รูปแบบผลไม่ถูกต้อง' }, 500);

    let result;
    try { result = JSON.parse(jsonMatch[0]); }
    catch { return json({ error: 'รูปแบบผลไม่ถูกต้อง' }, 500); }

    return json({ ok: true, result, mode });

  } catch (e) {
    console.error('Vision analysis failed:', e);
    return json({ error: 'เกิดข้อผิดพลาด กรุณาลองใหม่' }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
