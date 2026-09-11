// functions/api/generate-reading.js — Cloudflare Pages Function (Claude AI)

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

  const {
    sunSign, moonSign, ascSign, mcSign, venusSign,
    house2Sign, house6Sign, rahuSign, ketuSign, neptuneSign,
    dominant, wealthEl, healthEl, personName
  } = body;

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'AI ยังไม่พร้อม กรุณาติดต่อผู้ดูแล' }, 500);
  }

  const name = personName || 'คุณ';

  const prompt = `คุณเป็นนักดูดวงชาวไทยที่พูดจาตรงไปตรงมา เป็นกันเอง และไม่โอ้อวด
เขียนคำทำนายสำหรับ "${name}" จากข้อมูลดาวด้านล่าง

ข้อมูลดาว:
ดวงอาทิตย์=${sunSign}, ดวงจันทร์=${moonSign}, ลัคนา=${ascSign}, จุดสูงสุด=${mcSign}
ดาวศุกร์=${venusSign}, เรือนที่2=${house2Sign}, เรือนที่6=${house6Sign}
ราหู=${rahuSign}, เกตุ=${ketuSign}, เนปจูน=${neptuneSign}
ธาตุเด่น=${dominant}, ธาตุทรัพย์=${wealthEl}, ธาตุที่ต้องเสริม=${healthEl}

เขียน 5 หัวข้อ หัวข้อละ 3-4 ประโยค:
- งาน: จุดแข็งในการทำงาน ลักษณะงานที่เหมาะ และคำแนะนำที่ใช้ได้จริง
- เงิน: แหล่งรายได้ที่ถนัด จุดระวังเรื่องค่าใช้จ่าย และวิธีสะสมที่เหมาะกับนิสัย
- สุขภาพ: อวัยวะหรือระบบร่างกายที่ต้องดูแล วิธีดูแลตัวเองในชีวิตประจำวัน และอาหารที่ช่วยได้
- ความรัก: สไตล์การรัก เสน่ห์ที่คนรอบข้างมองเห็น และคู่แบบไหนที่เข้ากันได้จริง
- จิตวิญญาณ: บทเรียนหลักของชีวิต สิ่งที่ทำให้รู้สึกสงบ และทิศทางที่ควรเดินต่อ

กฎสำคัญ:
- ใช้ภาษาพูดไทยธรรมดา เป็นกันเอง เหมือนเพื่อนคุยกัน ห้ามใช้คำว่า "ท่าน" ให้ใช้ "คุณ" แทน
- ห้ามใช้คำแปลจากทฤษฎีจีน เช่น "ธาตุไฟ" "ธาตุดิน" "ธาตุน้ำ" ให้อธิบายเป็นคุณสมบัติของคนแทน
- ห้ามพูดชื่อดาว ราศี ลัคนา เรือนชะตา หรือตำแหน่งดาวตรงๆ เด็ดขาด เช่น ห้ามเขียน "ดวงอาทิตย์อยู่ในราศีมังกร" "ลัคนาเมษ" "เรือนที่ 6" "จุดสูงสุดในมังกร" ให้ใช้ข้อมูลดาวเป็นแค่ที่มาในการคิด แล้วแปลงเป็นลักษณะนิสัยหรือพฤติกรรมล้วนๆ เช่น "เป็นคนมีวินัยและอดทนสูง" แทน"ดวงอาทิตย์อยู่ในราศีมังกร" 
- อาหารต้องเป็นอาหารจริงที่คนไทยรู้จัก เช่น ผักใบเขียว ปลา ข้าวกล้อง ธัญพืช
- อาการสุขภาพต้องเป็นคำใช้งานจริง เช่น "ปวดหลัง" "นอนไม่หลับ" "ท้องไม่ดี"
- ห้ามใช้คำทับศัพท์อังกฤษ เช่น "เบรก" "สเปซ" ให้ใช้คำไทยแทน เช่น "หยุดพัก" "พื้นที่ส่วนตัว"
- ใช้เฉพาะคำภาษาไทยที่มีอยู่จริง ถ้าไม่แน่ใจคำไหนให้ใช้คำง่ายๆ แทน อย่าสร้างคำใหม่
- ห้ามเขียนคำซ้ำกันสองครั้งติดกัน เช่น "แบบแบบ" "ที่ที่"
- เฉพาะเจาะจงกับ ${name} ไม่ใช้ประโยคที่ใครได้รับก็ได้
- ตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น:
{"career":"...","money":"...","health":"...","love":"...","spirit":"..."}`;

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
        max_tokens: 2500,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('Claude API error:', JSON.stringify(data));
      return json({ error: 'AI ไม่สามารถสร้างผลได้ กรุณาลองใหม่' }, 502);
    }

    const textBlock = (data.content || []).find(function(b){ return b.type === 'text'; });
    const rawText = (textBlock && textBlock.text ? textBlock.text : '').trim();
    const jsonMatch = rawText.match(/\{[\s\S]*"spirit"[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('No JSON in response:', rawText.slice(0, 300));
      return json({ error: 'รูปแบบผลไม่ถูกต้อง' }, 500);
    }

    let reading;
    try {
      reading = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('JSON parse failed:', parseErr.message);
      return json({ error: 'รูปแบบผลไม่ถูกต้อง' }, 500);
    }

    return json({ ok: true, reading });

  } catch (e) {
    console.error('Generate reading failed:', e);
    return json({ error: 'เกิดข้อผิดพลาด กรุณาลองใหม่' }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
