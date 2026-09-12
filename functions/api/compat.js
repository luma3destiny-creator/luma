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

  const { person1, person2, chargeId, token } = body;

  if (!person1?.name || !person1?.birthDate || !person2?.name || !person2?.birthDate) {
    return json({ error: 'ข้อมูลไม่ครบ กรุณาระบุชื่อและวันเกิดของทั้งสองคน' }, 400);
  }

  if (!chargeId && !token) {
    return json({ error: 'กรุณาชำระเงินก่อนดูผลดวง' }, 402);
  }

  const isDevMode = chargeId === 'dev' || token === 'dev-token';

  if (!isDevMode) {
    let authorized = false;

    // Preferred: validate the persistent access token — same check as
    // /api/check-access, so returning users (restored via localStorage or
    // phone recovery) are authorized here too, not just a just-completed payment.
    if (token && env.DB) {
      try {
        const row = await env.DB.prepare(
          `SELECT id, expires_at FROM payments WHERE token = ? AND status = 'paid' LIMIT 1`
        ).bind(token).first();
        if (row && !(row.expires_at && new Date(row.expires_at + 'Z') < new Date())) {
          authorized = true;
        }
      } catch (e) {
        console.error('compat token check failed:', e);
      }
    }

    // Fallback: legacy check for a charge just completed in this same session.
    if (!authorized && chargeId) {
      if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
        console.warn('Redis not configured — skipping legacy chargeId check');
      } else {
        const key = encodeURIComponent('session:' + chargeId);
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

        if (tokenValue) authorized = true;
        // session key ไม่ลบ — ใช้ซ้ำได้ตลอด session (TTL 1h)
      }
    }

    if (!authorized) {
      return json({ error: 'การชำระเงินยังไม่สำเร็จ หรือสิทธิ์หมดอายุแล้ว กรุณาลองใหม่' }, 402);
    }
  }

  const g1 = person1.gender === 'm' ? 'ชาย' : 'หญิง';
  const g2 = person2.gender === 'm' ? 'ชาย' : 'หญิง';

  const p1animal = person1.animal || '';
  const p2animal = person2.animal || '';

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
4. พูดตรงๆ ทั้งดีและไม่ดี ห้ามประจบหรือทำให้ดูดีเกินจริง
5. แต่ละหัวข้อเขียน 3-4 ประโยคเต็มๆ ให้จบความ

แบ่งเป็น 4 ส่วน แต่ละส่วนขึ้นต้นด้วยชื่อหัวข้อตามด้วยเครื่องหมายทวิภาค จากนั้นขึ้นบรรทัดใหม่เขียนเนื้อหา 3-4 ประโยค แล้วเว้น 1 บรรทัดก่อนหัวข้อถัดไป

หัวข้อ 4 ส่วน:
ภาพรวมความเข้ากัน: เขียนว่าทั้งคู่โดยรวมเข้ากันได้แค่ไหน พลังงานของสองคนนี้ส่งเสริมกันหรือชนกัน
ความรักและการใช้ชีวิตร่วมกัน: เขียนว่าทั้งคู่รักกันและใช้ชีวิตร่วมกันอย่างไร มีจุดที่ลงตัวและจุดที่ต้องปรับตัวตรงไหน
จุดแข็งของคู่นี้: เขียนสิ่งที่ทำให้คู่นี้พิเศษและแข็งแกร่ง สิ่งที่ทำได้ดีเมื่ออยู่ด้วยกัน
สิ่งที่ต้องระวังและคำแนะนำ: เขียนจุดที่อาจเกิดปัญหาและวิธีแก้ที่ทำได้จริง

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
        model: 'claude-opus-5',
        max_tokens: 2000,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      return json({ error: 'ไม่สามารถเชื่อมต่อ AI ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง' }, 502);
    }

    const claudeData = await claudeRes.json();
    reading = ((claudeData.content || []).find(function(b){ return b.type === 'text'; }) || {}).text || '';
  } catch (e) {
    return json({ error: 'เกิดข้อผิดพลาดในการเชื่อมต่อ กรุณาลองใหม่' }, 502);
  }

  return json({ reading });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
