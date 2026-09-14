// functions/api/sendmail.js — Cloudflare Pages Function (Brevo)
//
// Builds the "ผลดวง" result email: a mobile-first, table-based HTML email
// in LUMA's own black/gold CI (matching https://luma-9qx.pages.dev/), plus a
// matching plain-text alternative. All user- and AI-supplied text is
// HTML-escaped before being inserted into the markup.
//
// Payload (from app.html):
//   {
//     email, chargeId,
//     reportType: 'reading' | 'compat',
//     personName, personName2,        // personName2 only for reportType 'compat'
//     overview,                       // optional short intro paragraph (plain text)
//     sections: [{ label, text }],    // the report body, in display order
//     summary: { highlight, watch, action } | null
//   }

const BRAND = {
  bg: '#080806',        // page/body background
  panel: '#12100c',     // card background
  border: '#3a3120',    // hairline border
  ink: '#F2EBDD',       // primary text (ivory)
  inkDim: '#c9c0ac',    // secondary text
  gold: '#D4AF4F',
  goldBright: '#E5C66B'
};

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

  if (!env.DB) return json({ error: 'ระบบส่งอีเมลยังไม่พร้อม' }, 503);
  let body;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 65536) return json({ error: 'รายงานมีขนาดใหญ่เกินไป' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid payload' }, 400);
  const { email, token } = body;
  if (typeof token !== 'string' || !token || token.length > 256 || ['dev', 'dev-token'].includes(token)) {
    return json({ error: 'กรุณากู้คืนสิทธิ์ก่อนส่งอีเมล' }, 401);
  }
  let order;
  try {
    order = await env.DB.prepare("SELECT id FROM payments WHERE token = ? AND status = 'paid' AND datetime(expires_at) > datetime('now') LIMIT 1").bind(token).first();
  } catch {
    return json({ error: 'ระบบตรวจสิทธิ์ยังไม่พร้อม' }, 503);
  }
  if (!order) return json({ error: 'สิทธิ์ไม่ถูกต้องหรือหมดอายุ กรุณากู้คืนสิทธิ์' }, 403);

  if (!email) {
    return json({ error: 'กรุณาระบุอีเมล' }, 400);
  }

  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'รูปแบบอีเมลไม่ถูกต้อง' }, 400);
  }

  if (!env.BREVO_API_KEY) {
    return json({ error: 'ระบบส่งอีเมลยังไม่พร้อม กรุณาติดต่อผู้ดูแล' }, 500);
  }

  const view = normalizePayload(body);
  if (!view.sections.length) return json({ error: 'กรุณารอให้รายงานโหลดเสร็จก่อนส่งอีเมล' }, 400);
  // Reserve atomically; failed/unknown provider outcomes still consume quota.
  // Key by payment ID so OTP token rotation cannot reset the limit.
  try {
    const reserved = await env.DB.prepare(`INSERT INTO email_send_attempts (payment_id)
      SELECT id FROM payments WHERE id = ? AND token = ? AND status = 'paid'
      AND datetime(expires_at) > datetime('now')
      AND (SELECT COUNT(*) FROM email_send_attempts WHERE created_at > datetime('now','-24 hours')) < 20
      AND (SELECT COUNT(*) FROM email_send_attempts WHERE payment_id = ? AND created_at > datetime('now','-24 hours')) < 3
      AND NOT EXISTS (SELECT 1 FROM email_send_attempts WHERE payment_id = ? AND created_at > datetime('now','-60 seconds'))
    `).bind(order.id, token, order.id, order.id).run();
    if (reserved.meta?.changes !== 1) return json({ error: 'ส่งอีเมลถี่เกินไปหรือครบโควตาแล้ว กรุณาลองภายหลัง' }, 429);
  } catch {
    return json({ error: 'ระบบจำกัดการส่งยังไม่พร้อม กรุณาลองภายหลัง' }, 503);
  }
  const htmlContent = buildEmailHtml(view);
  const textContent = buildEmailText(view);

  const brevoPayload = {
    sender: { name: 'LUMA', email: 'luma.3.destiny@gmail.com' },
    to: [{ email }],
    subject: view.subject,
    htmlContent,
    textContent
  };

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': env.BREVO_API_KEY
      },
      body: JSON.stringify(brevoPayload),
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
      return json({ error: 'ส่งอีเมลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' }, 502);
    }

    return json({ ok: true });
  } catch (e) {
    return json({ error: 'ยังยืนยันผลการส่งไม่ได้ กรุณาตรวจกล่องจดหมายก่อนลองใหม่' }, 502);
  }
}

// ── view model ───────────────────────────────────────────────────────────

// Turns the raw request body into a safe, fully-defaulted view model so the
// template builders below never have to guard against undefined/empty
// fields themselves (and never print "undefined" into the email).
export function normalizePayload(body) {
  const reportType = body.reportType === 'compat' ? 'compat' : 'reading';

  const personName = cleanText(body.personName, 'คุณ', 100);
  const personName2 = reportType === 'compat' ? cleanText(body.personName2, 'อีกคน', 100) : '';

  const overview = cleanText(body.overview, '', 600);

  const rawSections = Array.isArray(body.sections) ? body.sections : [];
  const sections = rawSections
    .slice(0, 10)
    .map(function (s) {
      return {
        label: cleanText(s && s.label, '', 80),
        text: cleanText(s && s.text, '', 4000)
      };
    })
    .filter(function (s) { return s.label && s.text; });

  const summary = normalizeSummary(body.summary);

  const title = reportType === 'compat' ? 'ผลดวงคู่' : 'ผลดวงส่วนบุคคล';
  const recipientLine = reportType === 'compat'
    ? `${personName} และ ${personName2}`
    : personName;

  const subject = reportType === 'compat'
    ? `ผลดวงคู่ของ ${personName} และ ${personName2} — LUMA`
    : `ผลดวงชะตาของ ${personName} — LUMA`;

  const dateLabel = formatThaiDate(new Date());

  return { reportType, personName, personName2, overview, sections, summary, title, recipientLine, subject, dateLabel };
}

function normalizeSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const highlight = cleanText(raw.highlight, '', 200);
  const watch = cleanText(raw.watch, '', 200);
  const action = cleanText(raw.action, '', 200);
  if (!highlight && !watch && !action) return null;
  return { highlight, watch, action };
}

function cleanText(v, fallback, maxLen) {
  const s = (v === null || v === undefined) ? '' : String(v).trim();
  if (!s) return fallback;
  return s.length > maxLen ? s.slice(0, maxLen - 1).trim() + '…' : s;
}

function formatThaiDate(d) {
  const months = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear() + 543}`;
}

// ── escaping ─────────────────────────────────────────────────────────────

export function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── HTML email ───────────────────────────────────────────────────────────

export function buildEmailHtml(v) {
  const summaryLabels = v.reportType === 'compat'
    ? { highlight: 'จุดเด่นของคู่นี้', watch: 'เรื่องที่ควรพูดคุยกัน', action: 'ลองทำด้วยกัน' }
    : { highlight: 'จุดเด่นของคุณ', watch: 'เรื่องที่ควรใส่ใจ', action: 'ลองทำดูสักอย่าง' };

  const summaryBlock = v.summary ? `
        <tr><td style="padding:0 24px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.panel};border:1px solid ${BRAND.border};border-radius:12px;">
            <tr><td style="padding:18px 20px;">
              <div style="color:${BRAND.goldBright};font-family:'IBM Plex Sans Thai',Sarabun,sans-serif;font-size:13px;font-weight:700;letter-spacing:.02em;margin-bottom:12px;">✨ สรุปของคุณ</div>
              ${summaryRow(summaryLabels.highlight, v.summary.highlight)}
              ${summaryRow(summaryLabels.watch, v.summary.watch)}
              ${summaryRow(summaryLabels.action, v.summary.action)}
            </td></tr>
          </table>
        </td></tr>` : '';

  const overviewBlock = v.overview ? `
        <tr><td style="padding:4px 24px 8px;">
          <p style="margin:0;color:${BRAND.inkDim};font-family:'IBM Plex Sans Thai',Sarabun,sans-serif;font-size:16px;line-height:1.7;">${escapeHtml(v.overview)}</p>
        </td></tr>` : '';

  const sectionsHtml = v.sections.length
    ? v.sections.map(sectionRow).join('')
    : `<tr><td style="padding:8px 24px;"><p style="margin:0;color:${BRAND.inkDim};font-family:'IBM Plex Sans Thai',Sarabun,sans-serif;font-size:16px;line-height:1.7;">ไม่มีเนื้อหารายงานในขณะนี้ กรุณาติดต่อผู้ดูแลหากพบปัญหานี้</p></td></tr>`;

  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(v.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${BRAND.bg};">

          <tr><td style="padding:8px 24px 20px;text-align:center;">
            <div style="color:${BRAND.goldBright};font-family:Georgia,'Times New Roman',serif;font-size:30px;letter-spacing:.06em;">LUMA</div>
            <div style="color:${BRAND.inkDim};font-family:'IBM Plex Sans Thai',Sarabun,sans-serif;font-size:13px;margin-top:4px;">โหราศาสตร์ไทย · ปาจื่อ · โหราศาสตร์สากล</div>
          </td></tr>

          <tr><td style="padding:0 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${BRAND.border};border-bottom:1px solid ${BRAND.border};">
              <tr><td style="padding:18px 0;">
                <div style="color:${BRAND.gold};font-family:'IBM Plex Sans Thai',Sarabun,sans-serif;font-size:12px;letter-spacing:.03em;margin-bottom:6px;">${escapeHtml(v.title)}</div>
                <div style="color:${BRAND.ink};font-family:'IBM Plex Sans Thai',Sarabun,sans-serif;font-size:18px;font-weight:700;">${escapeHtml(v.recipientLine)}</div>
                <div style="color:${BRAND.inkDim};font-family:'IBM Plex Sans Thai',Sarabun,sans-serif;font-size:13px;margin-top:4px;">จัดทำเมื่อ ${escapeHtml(v.dateLabel)}</div>
              </td></tr>
            </table>
          </td></tr>

          <tr><td style="height:20px;line-height:20px;font-size:0;">&nbsp;</td></tr>

          ${summaryBlock}

          <tr><td style="height:8px;line-height:8px;font-size:0;">&nbsp;</td></tr>

          ${overviewBlock}

          ${sectionsHtml}

          <tr><td style="height:12px;line-height:12px;font-size:0;">&nbsp;</td></tr>

          <tr><td style="padding:16px 24px 4px;border-top:1px solid ${BRAND.border};">
            <p style="margin:0 0 8px;color:${BRAND.inkDim};font-family:'IBM Plex Sans Thai',Sarabun,sans-serif;font-size:13px;line-height:1.7;">
              เนื้อหาข้างต้นเป็นการตีความทางโหราศาสตร์เพื่อการไตร่ตรองตนเอง ไม่ใช่การยืนยันเหตุการณ์ในอนาคตหรือคำแนะนำเชิงวิชาชีพ
            </p>
            <p style="margin:0;color:#6b6354;font-family:'IBM Plex Sans Thai',Sarabun,sans-serif;font-size:12px;">
              LUMA · โหราศาสตร์แห่งดวงดาว
            </p>
          </td></tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  function summaryRow(label, value) {
    if (!value) return '';
    return `<div style="margin-bottom:10px;">
        <span style="display:inline-block;color:${BRAND.gold};font-family:'IBM Plex Sans Thai',Sarabun,sans-serif;font-size:13px;font-weight:700;">${escapeHtml(label)}</span><br>
        <span style="color:${BRAND.ink};font-family:'IBM Plex Sans Thai',Sarabun,sans-serif;font-size:15px;line-height:1.6;">${escapeHtml(value)}</span>
      </div>`;
  }

  function sectionRow(s) {
    return `<tr><td style="padding:14px 24px;">
        <div style="color:${BRAND.goldBright};font-family:'IBM Plex Sans Thai',Sarabun,sans-serif;font-size:18px;font-weight:700;margin-bottom:6px;">${escapeHtml(s.label)}</div>
        <p style="margin:0;color:${BRAND.ink};font-family:'IBM Plex Sans Thai',Sarabun,sans-serif;font-size:16px;line-height:1.7;">${escapeHtml(s.text)}</p>
      </td></tr>`;
  }
}

// ── plain-text alternative ─────────────────────────────────────────────────

export function buildEmailText(v) {
  const lines = [];
  lines.push('LUMA — ' + v.title);
  lines.push(v.recipientLine);
  lines.push('จัดทำเมื่อ ' + v.dateLabel);
  lines.push('');

  if (v.summary) {
    const L = v.reportType === 'compat'
      ? { highlight: 'จุดเด่นของคู่นี้', watch: 'เรื่องที่ควรพูดคุยกัน', action: 'ลองทำด้วยกัน' }
      : { highlight: 'จุดเด่นของคุณ', watch: 'เรื่องที่ควรใส่ใจ', action: 'ลองทำดูสักอย่าง' };
    lines.push('สรุปของคุณ');
    if (v.summary.highlight) lines.push('- ' + L.highlight + ': ' + v.summary.highlight);
    if (v.summary.watch) lines.push('- ' + L.watch + ': ' + v.summary.watch);
    if (v.summary.action) lines.push('- ' + L.action + ': ' + v.summary.action);
    lines.push('');
  }

  if (v.overview) {
    lines.push(v.overview);
    lines.push('');
  }

  if (v.sections.length) {
    v.sections.forEach(function (s) {
      lines.push(s.label);
      lines.push(s.text);
      lines.push('');
    });
  } else {
    lines.push('ไม่มีเนื้อหารายงานในขณะนี้ กรุณาติดต่อผู้ดูแลหากพบปัญหานี้');
    lines.push('');
  }

  lines.push('---');
  lines.push('เนื้อหาข้างต้นเป็นการตีความทางโหราศาสตร์เพื่อการไตร่ตรองตนเอง ไม่ใช่การยืนยันเหตุการณ์ในอนาคตหรือคำแนะนำเชิงวิชาชีพ');
  lines.push('LUMA — โหราศาสตร์แห่งดวงดาว');

  return lines.join('\n');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
