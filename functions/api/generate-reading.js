// functions/api/generate-reading.js — Cloudflare Pages Function (Claude AI)
//
// The free 5-area reading. No token or payment is required -- but every call
// is counted against the free AI quota (per Cloudflare client IP, plus one
// ceiling for all free callers). See functions/lib/ai-quota.mjs.
import { reserveAiCall, recordAiOutcome, quotaResponse, readJsonBody, boundedText } from '../lib/ai-quota.mjs';
import { resolveAiMode, callAiProvider } from '../lib/ai-provider.mjs';

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

  // Every one of these is pasted into the prompt, so an oversized value is an
  // oversized bill. Real values are a sign or element name -- a few words.
  const SIGN_FIELDS = ['sunSign','moonSign','ascSign','mcSign','venusSign','house2Sign',
                       'house6Sign','rahuSign','ketuSign','neptuneSign','dominant','wealthEl','healthEl'];
  for (const f of SIGN_FIELDS) {
    if (!boundedText(body[f], 40).ok) return json({ error: 'ข้อมูลไม่ถูกต้อง' }, 400);
  }
  if (!boundedText(body.personName, 100).ok) return json({ error: 'ชื่อยาวเกินไป' }, 400);

  const {
    sunSign, moonSign, ascSign, mcSign, venusSign,
    house2Sign, house6Sign, rahuSign, ketuSign, neptuneSign,
    dominant, wealthEl, healthEl, personName
  } = body;


  const name = personName || 'คุณ';

  const prompt = `คุณเป็นนักดูดวงชาวไทยที่พูดจาตรงไปตรงมา เป็นกันเอง และไม่โอ้อวด
เขียนคำทำนายสำหรับ "${name}" จากข้อมูลดาวด้านล่าง

ข้อมูลดาว:
ดวงอาทิตย์=${sunSign}, ดวงจันทร์=${moonSign}, ลัคนา=${ascSign}, จุดสูงสุด=${mcSign}
ดาวศุกร์=${venusSign}, เรือนที่2=${house2Sign}, เรือนที่6=${house6Sign}
ราหู=${rahuSign}, เกตุ=${ketuSign}, เนปจูน=${neptuneSign}
ธาตุเด่น=${dominant}, ธาตุทรัพย์=${wealthEl}, ธาตุที่ต้องเสริม=${healthEl}

เขียน 5 หัวข้อ หัวข้อละ 2-3 ประโยคสั้น กระชับ ไม่กล่าวซ้ำ แต่ละหัวข้อควรมีตัวอย่างพฤติกรรมที่จับต้องได้อย่างน้อยหนึ่งตัวอย่าง และข้อเสนอแนะที่ทำได้จริงอย่างน้อยหนึ่งอย่าง:
- งาน: จุดแข็งในการทำงานพร้อมตัวอย่างพฤติกรรม ลักษณะงานที่เหมาะ และคำแนะนำที่ใช้ได้จริงหนึ่งอย่าง
- เงิน: แหล่งรายได้ที่ถนัด จุดที่ควรทบทวนเรื่องค่าใช้จ่าย และวิธีสะสมที่เหมาะกับนิสัยหนึ่งอย่าง
- การดูแลตัวเองและสมดุลชีวิต: จังหวะการใช้พลังงานและการพักผ่อนของคนแบบนี้ จุดที่มักละเลยจนเสียสมดุล (เช่น ทำงานหักโหม นอนดึก ไม่ยอมพัก) และกิจวัตรดูแลตัวเองที่ทำได้จริงหนึ่งอย่าง ห้ามระบุอวัยวะ โรค อาการเจ็บป่วย หรือความเสี่ยงสุขภาพใดๆ ทั้งสิ้น ให้พูดถึงพฤติกรรมและความสมดุลในชีวิตเท่านั้น
- ความรัก: สไตล์การรัก เสน่ห์ที่คนรอบข้างมองเห็นพร้อมตัวอย่าง และคู่แบบไหนที่เข้ากันได้จริง
- จิตวิญญาณ: บทเรียนหลักของชีวิต สิ่งที่ทำให้รู้สึกสงบ และทิศทางที่ควรเดินต่อ

กฎสำคัญ:
- ใช้ภาษาพูดไทยธรรมดา เป็นกันเอง เหมือนเพื่อนคุยกัน ห้ามใช้คำว่า "ท่าน" ให้ใช้ "คุณ" แทน
- ห้ามใช้คำแปลจากทฤษฎีจีน เช่น "ธาตุไฟ" "ธาตุดิน" "ธาตุน้ำ" ให้อธิบายเป็นคุณสมบัติของคนแทน
- ห้ามพูดชื่อดาว ราศี ลัคนา เรือนชะตา หรือตำแหน่งดาวตรงๆ เด็ดขาด เช่น ห้ามเขียน "ดวงอาทิตย์อยู่ในราศีมังกร" "ลัคนาเมษ" "เรือนที่ 6" "จุดสูงสุดในมังกร" ให้ใช้ข้อมูลดาวเป็นแค่ที่มาในการคิด แล้วแปลงเป็นลักษณะนิสัยหรือพฤติกรรมล้วนๆ เช่น "เป็นคนมีวินัยและอดทนสูง" แทน"ดวงอาทิตย์อยู่ในราศีมังกร"
- ห้ามระบุชื่อโรค อวัยวะที่มีปัญหา อาการเจ็บป่วย หรือความเสี่ยงด้านสุขภาพโดยเด็ดขาดในทุกหัวข้อ แม้แต่ในหัวข้ออื่นที่ไม่ใช่การดูแลตัวเอง
- ห้ามใช้คำทับศัพท์อังกฤษ เช่น "เบรก" "สเปซ" ให้ใช้คำไทยแทน เช่น "หยุดพัก" "พื้นที่ส่วนตัว"
- ใช้เฉพาะคำภาษาไทยที่มีอยู่จริง ถ้าไม่แน่ใจคำไหนให้ใช้คำง่ายๆ แทน อย่าสร้างคำใหม่
- ห้ามเขียนคำซ้ำกันสองครั้งติดกัน เช่น "แบบแบบ" "ที่ที่"
- เฉพาะเจาะจงกับ ${name} ไม่ใช้ประโยคที่ใครได้รับก็ได้
- ห้ามยืนยันว่าเหตุการณ์ในอนาคตจะเกิดขึ้นแน่นอน ให้เขียนในเชิงแนวโน้มและมุมมองเพื่อการไตร่ตรอง ไม่ใช่คำพยากรณ์ที่ฟันธง

หลังจากเขียน 5 หัวข้อแล้ว ให้สรุปเป็น "summary" 3 ประโยคสั้นๆ (ประโยคละไม่เกิน 20 คำ) โดยดึงมาจากเนื้อหา 5 หัวข้อที่เขียนไปแล้วเท่านั้น ห้ามเพิ่มข้อมูลใหม่ที่ไม่มีในเนื้อหา:
- highlight: จุดเด่นที่สุดของ ${name} จากเนื้อหาทั้งหมด
- watch: เรื่องที่ ${name} ควรใส่ใจหรือระวังมากที่สุด
- action: สิ่งที่ทำได้จริงหนึ่งอย่างที่ ${name} ควรลองทำ

ตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น:
{"career":"...","money":"...","health":"...","love":"...","spirit":"...","summary":{"highlight":"...","watch":"...","action":"..."}}`;

  // Reserved only now: input is valid and the key exists, so this request will
  // really reach the provider. The slot is not given back if the call fails.
  // Test mode is decided by the SERVER (see ai-provider.mjs). A request that
  // asks for it without permission is refused here, before any quota.
  const aiMode = await resolveAiMode(env, request);
  if (aiMode.mode === 'refuse') return aiMode.response;
  // The real path needs the provider key and is refused here, before any
  // quota is reserved. Test mode never calls the provider, so it does not.
  if (aiMode.mode === 'real' && !env.ANTHROPIC_API_KEY) {
    return json({ error: 'ระบบวิเคราะห์ AI ยังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแล', code: 'AI_NOT_CONFIGURED' }, 503);
  }

  const quota = await reserveAiCall(env, { bucket: 'free', route: 'generate-reading', request });
  if (!quota.ok) return quotaResponse(quota);

  try {
  const aiStartedAt = Date.now();
let aiHeadersAt;
let res;

try {
  res = await callAiProvider(aiMode, 'generate-reading', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 2800,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: prompt }]
    })
  });
  aiHeadersAt = Date.now();
} catch (e) {
  await recordAiOutcome(env, quota.reservationId, 'unknown');
  throw e;
}

await recordAiOutcome(
  env,
  quota.reservationId,
  aiMode.mode === 'mock'
    ? 'mock'
    : (res.ok ? 'ok' : 'provider_error')
);

const data = await res.json();

console.log('reading_ai_metrics', JSON.stringify({
  mode: aiMode.mode,
  status: res.status,
  headers_ms: aiHeadersAt - aiStartedAt,
  body_ready_ms: Date.now() - aiStartedAt,
  stop_reason: data.stop_reason ?? null,
  input_tokens: data.usage?.input_tokens ?? null,
  output_tokens: data.usage?.output_tokens ?? null
}));

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

    // summary is a nice-to-have (used for the "สรุปของคุณ" email block) —
    // never fail the whole reading if it's missing or malformed.
    if (!reading.summary || typeof reading.summary !== 'object') {
      reading.summary = null;
    }

    return json({ ok: true, reading, ...(aiMode.mode === 'mock' ? { mock: true } : {}) });

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
