import { checkPaidAccess } from '../lib/paid-access.mjs';
// functions/api/compat.js — Cloudflare Pages Function

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

  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid payload' }, 400);
  const { person1, person2, token } = body;

  if (!person1?.name || !person1?.birthDate || !person2?.name || !person2?.birthDate) {
    return json({ error: 'ข้อมูลไม่ครบ กรุณาระบุชื่อและวันเกิดของทั้งสองคน' }, 400);
  }

  const access = await checkPaidAccess(env, token);
  if (!access.ok) return json({ error: access.error }, access.status);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'AI ยังไม่พร้อม' }, 503);

  const g1 = person1.gender === 'm' ? 'ชาย' : 'หญิง';
  const g2 = person2.gender === 'm' ? 'ชาย' : 'หญิง';

  const p1animal = person1.animal || '';
  const p2animal = person2.animal || '';

  const SUMMARY_MARKER = '===SUMMARY_JSON===';

  const prompt = `คุณเป็นนักโหราศาสตร์ผู้เชี่ยวชาญ วิเคราะห์ความเข้ากันระหว่างสองคนนี้

ข้อมูลที่ผ่านการคำนวณและยืนยันแล้ว ห้ามคำนวณหรือเปลี่ยนแปลงใดๆ:

ชื่อ: ${person1.name}
เพศ: ${g1}
วันเกิด: ${person1.birthDate}
เวลาเกิด: ${person1.birthTime || 'ไม่ทราบ'}
นักษัตร: ปี${p1animal || 'ไม่ระบุ'}

ชื่อ: ${person2.name}
เพศ: ${g2}
วันเกิด: ${person2.birthDate}
เวลาเกิด: ${person2.birthTime || 'ไม่ทราบ'}
นักษัตร: ปี${p2animal || 'ไม่ระบุ'}

สำคัญมาก: ข้อมูลนักษัตรข้างบนถูกต้องแล้ว (คำนวณด้วยหลัก BaZi ปรับวัน立春) ห้ามคำนวณหรืออนุมานนักษัตรจากปีเกิดเอง

กฎการเขียน:
1. ห้ามพูดถึงชื่อศาสตร์หรือคำศัพท์เฉพาะทางใดๆ เช่น ราศี, ธาตุ, ลัคนา, นักษัตร, ดาวอังคาร, ดาวพุธ, Mercury, Mars, BaZi ฯลฯ — ให้แปลงเป็นคำอธิบายบุคลิกและชีวิตจริงที่คนทั่วไปเข้าใจทันที
2. ใช้คำว่า "คุณ" ตลอด ห้ามใช้ "ท่าน" เด็ดขาด ใช้ชื่อจริงของทั้งสองคน ห้ามใช้ "คนที่ 1" "คนที่ 2"
3. พูดถึงชีวิตจริงๆ ว่าทั้งคู่อยู่ด้วยกันแล้วเป็นอย่างไร เข้ากันในเรื่องอะไร ขัดกันตรงไหน และควรทำอย่างไรให้ความสัมพันธ์ดีขึ้น
4. พูดตรงๆ ทั้งดีและไม่ดี ห้ามประจบหรือทำให้ดูดีเกินจริง และห้ามเขียนคำทำนายเชิงลบเกินจริงเพื่อกระตุ้นให้ซื้อบริการเพิ่มเติม
5. แต่ละหัวข้อเขียน 3-4 ประโยคเต็มๆ ให้จบความ
6. ห้ามใช้คะแนนความเข้ากัน (compatibility score) หรือเนื้อหาส่วนนี้เป็นข้อสรุปฟันธงว่าควรคบหรือเลิกกัน ให้เป็นข้อมูลประกอบการตัดสินใจของทั้งคู่เองเท่านั้น
7. ห้ามระบุชื่อโรค อวัยวะที่มีปัญหา อาการเจ็บป่วย หรือความเสี่ยงด้านสุขภาพของฝ่ายใดฝ่ายหนึ่งโดยเด็ดขาด
8. ห้ามแต่งข้อมูลส่วนตัวของทั้งสองคนที่ไม่ได้ให้มา (เช่น อาชีพ ครอบครัว ประวัติ)

แบ่งเป็น 4 ส่วน แต่ละส่วนขึ้นต้นด้วยชื่อหัวข้อตามด้วยเครื่องหมายทวิภาค จากนั้นขึ้นบรรทัดใหม่เขียนเนื้อหา 3-4 ประโยค แล้วเว้น 1 บรรทัดก่อนหัวข้อถัดไป

หัวข้อ 4 ส่วน:
ภาพรวมความเข้ากัน: เขียนว่าทั้งคู่โดยรวมเข้ากันได้แค่ไหน พลังงานของสองคนนี้ส่งเสริมกันหรือชนกัน
ความรักและการใช้ชีวิตร่วมกัน: เขียนว่าทั้งคู่รักกันและใช้ชีวิตร่วมกันอย่างไร มีจุดที่ลงตัวและจุดที่ต้องปรับตัวตรงไหน
จุดแข็งของคู่นี้: เขียนสิ่งที่ทำให้คู่นี้พิเศษและแข็งแกร่ง สิ่งที่ทำได้ดีเมื่ออยู่ด้วยกัน
สิ่งที่ต้องระวังและคำแนะนำ: เขียนจุดที่อาจเกิดปัญหาและวิธีแก้ที่ทำได้จริง

ห้ามใช้เครื่องหมาย # หรือ * หรือ - เด็ดขาด ใช้ตัวอักษรธรรมดาเท่านั้น

หลังจากเขียนครบ 4 หัวข้อแล้ว ให้ขึ้นบรรทัดใหม่ พิมพ์ข้อความนี้ตรงตัว (ไม่ต้องมีอะไรอื่นในบรรทัดนั้น):
${SUMMARY_MARKER}
จากนั้นในบรรทัดถัดไป เขียน JSON บรรทัดเดียว (ห้ามขึ้นบรรทัดใหม่ในค่า ห้ามมีข้อความอื่นปนอยู่) สรุปจากเนื้อหา 4 หัวข้อข้างต้นเท่านั้น ห้ามเพิ่มข้อมูลใหม่ ประโยคละไม่เกิน 20 คำ ตามรูปแบบนี้:
{"highlight":"จุดเด่นที่สุดของความสัมพันธ์คู่นี้","watch":"เรื่องที่ทั้งคู่ควรพูดคุยหรือระวังมากที่สุด","action":"สิ่งที่ทำได้จริงหนึ่งอย่างที่ทั้งคู่ควรลองทำด้วยกัน"}`;

  let reading, summary = null;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 2200,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      return json({ error: 'ไม่สามารถเชื่อมต่อ AI ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง' }, 502);
    }

    const claudeData = await claudeRes.json();
    const rawText = ((claudeData.content || []).find(function(b){ return b.type === 'text'; }) || {}).text || '';

    const markerIdx = rawText.indexOf(SUMMARY_MARKER);
    if (markerIdx === -1) {
      reading = rawText.trim();
    } else {
      reading = rawText.slice(0, markerIdx).trim();
      const summaryPart = rawText.slice(markerIdx + SUMMARY_MARKER.length).trim();
      const summaryMatch = summaryPart.match(/\{[\s\S]*\}/);
      if (summaryMatch) {
        try {
          const parsed = JSON.parse(summaryMatch[0]);
          if (parsed && typeof parsed === 'object') summary = parsed;
        } catch (e) {
          console.warn('compat summary JSON parse failed:', e.message);
        }
      }
    }
  } catch (e) {
    return json({ error: 'เกิดข้อผิดพลาดในการเชื่อมต่อ กรุณาลองใหม่' }, 502);
  }

  return json({ reading, summary });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
