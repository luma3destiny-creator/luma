import { checkPaidAccess } from '../lib/paid-access.mjs';
import { reserveAiCall, recordAiOutcome, quotaResponse, readJsonBody, boundedText, boundedString } from '../lib/ai-quota.mjs';
import { resolveAiMode, callAiProvider } from '../lib/ai-provider.mjs';

// The provider accepts images up to about 5 MB; base64 adds a third. A body
// larger than this is not a photo anyone needs read, and forwarding it would
// be the most expensive request this site can make.
const MAX_VISION_BODY_BYTES = 7 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = 7 * 1024 * 1024 - 4096;
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

  const parsed = await readJsonBody(request, MAX_VISION_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const { imageBase64, mediaType, mode, personName, token } = body;
  if (!imageBase64 || !mode) return json({ error: 'ข้อมูลไม่ครบ' }, 400);
  if (typeof imageBase64 !== 'string' || imageBase64.length > MAX_IMAGE_BASE64_CHARS) {
    return json({ error: 'รูปภาพมีขนาดใหญ่เกินไป' }, 413);
  }
  if (mode !== 'face' && mode !== 'palm') return json({ error: 'mode ไม่ถูกต้อง' }, 400);
  // mediaType must be a string: it is lower-cased below, and a number there
  // would throw instead of being refused.
  if (!boundedText(personName, 100).ok || !boundedString(mediaType, 40).ok) {
    return json({ error: 'ข้อมูลไม่ถูกต้อง' }, 400);
  }

  // ── Server-side entitlement check ────────────────────────────────────────
  // Face/palm reading is part of the paid package. Until now this endpoint
  // trusted the browser's own unlocked state, so a direct POST bypassed the
  // paywall entirely and spent AI credit for free. The browser's opinion is
  // no longer accepted as proof: the token it sends must match a row that
  // this database says is genuinely paid and not expired.
  //
  // Fails CLOSED on every failure path — missing token, unknown/forged token,
  // the retired 'dev-token' (it simply matches no paid row), expired access,
  // or the database being unreachable. In none of those cases do we reach the
  // AI call below. Nothing here changes prices or what an existing paying
  // customer is entitled to.
  const access = await checkPaidAccess(env, token);
  if (!access.ok) return json({ ok: false, error: access.error }, access.status);

  if (!env.ANTHROPIC_API_KEY) return json({ error: 'AI ยังไม่พร้อม' }, 500);

  const validTypes = ['image/jpeg','image/png','image/gif','image/webp'];
  const rawType = (mediaType || '').toLowerCase().replace('image/jpg','image/jpeg');
  const safeType = validTypes.includes(rawType) ? rawType : 'image/jpeg';

  const name = personName || 'คุณ';

  const guardrails = `กฎสำคัญ (ต้องทำตามทุกข้อ ในทุกหัวข้อที่เป็นข้อความ):
- ทุกประโยคที่ตีความบุคลิก อุปนิสัย การงาน การเงิน ความรัก หรือชะตาชีวิต ต้องเขียนในเชิง "ตามความเชื่อ/ตำราดั้งเดิม ลักษณะนี้มักถูกตีความว่า..." หรือสำนวนใกล้เคียงที่สื่อชัดว่าเป็นมุมมองความเชื่อดั้งเดิม ไม่ใช่การฟันธงว่า "${name}" เป็นคนแบบนั้นจริง หรือเหตุการณ์นั้นจะเกิดขึ้นจริงกับตัวเขา
- ห้ามใช้คำยืนยันเด็ดขาดว่า "เป็นคนที่..." "มีนิสัย..." "จะ...แน่นอน" ให้ใช้สำนวนเชิงตีความ เช่น "มักถูกมองว่า" "สื่อถึง" "ตามความเชื่อดั้งเดิมบ่งบอกถึง" แทนทุกครั้ง
- แต่ละหัวข้อควรมีทั้งจุดที่โดดเด่นและสิ่งที่ควรพัฒนา อ้างอิงสิ่งที่เห็นจริงในรูป ไม่ใช่คำเตือนหรือคำทำนายร้ายแรง
- ห้ามระบุชื่อโรค อวัยวะที่มีปัญหา อาการเจ็บป่วย ความเสี่ยงด้านสุขภาพ หรือสภาพจิตใจ/ความผิดปกติทางจิตใดๆ ทั้งสิ้นในทุกหัวข้อ และห้ามอนุมานสุขภาพกายหรือสุขภาพจิตที่แท้จริงของบุคคลในรูปไม่ว่าทางใด
- ห้ามระบุหรือบ่งชี้สถานะทางการเงินจริงของบุคคลในรูป (เช่น รวย จน มีหนี้ หรือไม่) ให้พูดได้เฉพาะแนวโน้ม/นิสัยเชิงการเงินตามความเชื่อดั้งเดิมเท่านั้น
- ห้ามยืนยันว่าเหตุการณ์ในอนาคตจะเกิดขึ้นแน่นอน หรือฟันธงเรื่องบุคลิก ความสามารถ หรือชะตาชีวิตราวกับเป็นข้อเท็จจริง ให้นำเสนอในเชิงมุมมองความเชื่อดั้งเดิมเพื่อการไตร่ตรองส่วนตัวเท่านั้น
- ใช้ภาษาไทยพูดง่าย เป็นกันเอง เฉพาะเจาะจงกับ "${name}" ไม่ใช่ประโยคที่ใครได้รับก็ได้
- "key_points" ให้ดึงสรุปมาจากเนื้อหาที่เขียนไว้แล้วเท่านั้น ห้ามเพิ่มข้อมูลใหม่ที่ไม่มีในเนื้อหาข้างต้น อย่างมาก 3 ข้อ ข้อละไม่เกิน 15 คำ และต้องคงสำนวนเชิงตีความไว้เช่นเดียวกับข้อความต้นฉบับ (ห้ามฟันธง)`;

  const prompts = {
    face: `คุณเป็นผู้เชี่ยวชาญโหงวเฮ้งชาวไทยที่อ่านใบหน้าตามศาสตร์จีนโบราณอย่างตรงไปตรงมา
วิเคราะห์ใบหน้าในรูปสำหรับ "${name}"

${guardrails}

ตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น:
{
  "forehead": "วิเคราะห์หน้าผาก 3-4 ประโยค เชิงตีความตามตำรา (ตามความเชื่อดั้งเดิมมักถูกตีความว่า...) ทั้งจุดเด่นและสิ่งที่ควรพัฒนา",
  "eyes": "วิเคราะห์ตาและคิ้ว 3-4 ประโยค เชิงตีความตามตำรา ทั้งจุดเด่นและสิ่งที่ควรพัฒนา",
  "nose": "วิเคราะห์จมูก 3-4 ประโยค เชิงตีความตามตำรา ทั้งจุดเด่นและสิ่งที่ควรพัฒนา",
  "mouth": "วิเคราะห์ปากและคาง 3-4 ประโยค เชิงตีความตามตำรา ทั้งจุดเด่นและสิ่งที่ควรพัฒนา",
  "overall": "ภาพรวม 3-4 ประโยค เชิงตีความตามความเชื่อดั้งเดิม ไม่ฟันธง",
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
  "lifeline": "วิเคราะห์เส้นชีวิต 3-4 ประโยค เชิงตีความตามตำรา (ตามความเชื่อดั้งเดิมมักถูกตีความว่า...) ทั้งจุดเด่นและสิ่งที่ควรพัฒนา",
  "headline": "วิเคราะห์เส้นสมอง 3-4 ประโยค เชิงตีความตามตำรา ทั้งจุดเด่นและสิ่งที่ควรพัฒนา",
  "heartline": "วิเคราะห์เส้นจิตใจ 3-4 ประโยค เชิงตีความตามตำรา ทั้งจุดเด่นและสิ่งที่ควรพัฒนา",
  "fateline": "วิเคราะห์เส้นวาสนา 3-4 ประโยค เชิงตีความตามตำรา ทั้งจุดเด่นและสิ่งที่ควรพัฒนา",
  "overall": "ภาพรวม 3-4 ประโยค เชิงตีความตามความเชื่อดั้งเดิม ไม่ฟันธง",
  "key_points": ["ประเด็นสำคัญที่ 1", "ประเด็นสำคัญที่ 2", "ประเด็นสำคัญที่ 3"],
  "personality": ["บุคลิกที่ 1 (สั้นกระชับ)", "บุคลิกที่ 2", "บุคลิกที่ 3"],
  "strengths": ["จุดแข็งที่ 1", "จุดแข็งที่ 2", "จุดแข็งที่ 3"],
  "warnings": ["สิ่งที่ควรระวังในเชิงพฤติกรรมที่ 1", "สิ่งที่ควรระวังในเชิงพฤติกรรมที่ 2", "สิ่งที่ควรระวังในเชิงพฤติกรรมที่ 3"],
  "life_advice": ["คำแนะนำที่ 1", "คำแนะนำที่ 2", "คำแนะนำที่ 3"]
}`
  };

  const prompt = prompts[mode];
  if (!prompt) return json({ error: 'mode ไม่ถูกต้อง' }, 400);

  // Counted per PAYMENT, not per token, and shared with the couple reading:
  // one paid allowance per purchase. Reserved only now and never given back.
  // Test mode is decided by the SERVER (see ai-provider.mjs). A request that
  // asks for it without permission is refused here, before any quota.
  const aiMode = resolveAiMode(env, request);
  if (aiMode.mode === 'refuse') return aiMode.response;

  const quota = await reserveAiCall(env, { bucket: 'paid', route: 'analyze-vision', paymentId: access.paymentId });
  if (!quota.ok) return quotaResponse(quota);

  try {
    let res;
    try {
      res = await callAiProvider(aiMode, 'analyze-vision', {
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
    } catch (e) {
      await recordAiOutcome(env, quota.reservationId, 'unknown');
      throw e;
    }
    await recordAiOutcome(env, quota.reservationId,
      aiMode.mode === 'mock' ? 'mock' : (res.ok ? 'ok' : 'provider_error'));

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

    return json({ ok: true, result, mode, ...(aiMode.mode === 'mock' ? { mock: true } : {}) });

  } catch (e) {
    console.error('Vision analysis failed:', e);
    return json({ error: 'เกิดข้อผิดพลาด กรุณาลองใหม่' }, 500);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
