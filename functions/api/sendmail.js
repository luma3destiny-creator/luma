// functions/api/sendmail.js — Cloudflare Pages Function (Brevo)

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

  const { email, readingHtml, personName, chargeId } = body;

  if (!email) {
    return json({ error: 'กรุณาระบุอีเมล' }, 400);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'รูปแบบอีเมลไม่ถูกต้อง' }, 400);
  }

  if (!env.BREVO_API_KEY) {
    return json({ error: 'ระบบส่งอีเมลยังไม่พร้อม กรุณาติดต่อผู้ดูแล' }, 500);
  }

  const displayName = personName || 'คุณ';
  const brevoPayload = {
    sender: { name: 'LUMA', email: 'luma.3.destiny@gmail.com' },
    to: [{ email: email }],
    subject: `ผลดวงชะตาของ${displayName} — LUMA`,
    htmlContent: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0e0c1a;color:#e8e0ff;padding:32px;border-radius:16px;">
        <div style="text-align:center;margin-bottom:24px;">
          <h1 style="color:#c4b0ff;font-size:28px;margin:0;">✨ LUMA</h1>
          <p style="color:#9b8ec4;margin:8px 0 0;">ดวงชะตาและโหราศาสตร์</p>
        </div>
        <p style="font-size:16px;line-height:1.7;">สวัสดีคุณ ${displayName},</p>
        <p style="font-size:15px;line-height:1.8;color:#c8bef0;">
          ขอบคุณที่ใช้บริการ LUMA นี่คือผลการวิเคราะห์ดวงชะตาของคุณค่ะ ✨
        </p>
        <div style="background:#1a1530;border-radius:12px;padding:24px;margin:20px 0;color:#e0d8ff;font-size:15px;line-height:1.9;">
          ${readingHtml || '(ไม่มีข้อมูล)'}
        </div>
        <p style="font-size:15px;line-height:1.8;color:#c8bef0;">
          หากมีข้อสงสัยหรือต้องการคำปรึกษาเพิ่มเติม สามารถกลับมาใช้บริการ LUMA ได้เสมอนะคะ ✨
        </p>
        <div style="margin-top:32px;padding-top:20px;border-top:1px solid #2a2040;text-align:center;color:#6b5f8a;font-size:13px;">
          <p>LUMA — ดวงชะตาที่คุณไว้วางใจ</p>
        </div>
      </div>
    `
  };

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': env.BREVO_API_KEY
      },
      body: JSON.stringify(brevoPayload)
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('Brevo error:', data);
      return json({ error: 'ส่งอีเมลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' }, 502);
    }

    return json({ ok: true, messageId: data.messageId });
  } catch (e) {
    console.error('Email send failed:', e);
    return json({ error: 'เกิดข้อผิดพลาดในการส่งอีเมล กรุณาลองใหม่' }, 502);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
