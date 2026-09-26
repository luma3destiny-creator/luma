// functions/lib/sms.mjs — the one place that knows how to send an SMS.
//
// Deliberately a thin adapter: which provider we use for Thai OTP is NOT
// settled. Keeping the provider behind this interface means swapping it is a
// one-file change, not a rewrite.
//
// env.SMS_PROVIDER selects the implementation:
//   'mock'  — records nothing anywhere the public can reach, sends nothing.
//             The default, and the only value that should be set in Preview
//             until real sending has been signed off. Costs nothing.
//   'brevo' — Brevo transactional SMS.
//   'thsms' — THSMS v2 REST (adapter written, never exercised against a live
//             account — treat as unproven).
//
// Nothing here ever sends unless SMS_PROVIDER is explicitly set to a real
// provider, so a missing config can never silently start spending money.

export const SMS_MOCK_OUTBOX = [];   // test-visible; per-isolate, never served

/**
 * PREVIEW-ONLY TEST OUTBOX.
 *
 * A tester needs to read the code that "was sent". Returning it from the API or
 * printing it to the log would hand every code to anyone who can reach Preview
 * or read its logs, so neither happens. Instead, for an explicitly listed set of
 * internal test numbers, the mock provider writes the message into a table only
 * the account owner can read (wrangler d1 / the D1 console).
 *
 * Three gates, all of which must be open, and all of which are closed by
 * default. Any real provider skips this path entirely.
 */
async function maybeRecordTestMessage(env, { to, text, code }) {
  if ((env.SMS_PROVIDER || 'mock').toLowerCase() !== 'mock') return;
  if (env.OTP_TEST_OUTBOX !== 'true') return;
  const allow = String(env.OTP_TEST_PHONES || '')
    .split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
  const target = String(to).replace(/\D/g, '');
  if (allow.indexOf(target) === -1) return;   // not an internal test number
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `INSERT INTO otp_test_outbox (phone, code, body, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    ).bind(target, code || null, text || null).run();
  } catch (e) {
    // The table only exists in Preview. Its absence must never break a send.
    console.log('sms: test outbox unavailable — skipped');
  }
}

/**
 * @returns {{ok:boolean, status:'sent'|'failed'|'unknown', id?:string, reason?:string, provider:string}}
 */
export async function sendSms(env, { to, text, code = null, tag = 'luma-otp' }) {
  const provider = (env.SMS_PROVIDER || 'mock').toLowerCase();

  if (provider === 'mock') {
    // Never leave the message body in a log line — an OTP is a credential.
    SMS_MOCK_OUTBOX.push({ to, text, tag, at: new Date().toISOString() });
    await maybeRecordTestMessage(env, { to, text, code });
    console.log('sms: mock provider — nothing sent');
    return { ok: true, status: 'sent', id: 'mock-' + SMS_MOCK_OUTBOX.length, provider: 'mock' };
  }

  if (provider === 'brevo') {
    if (!env.BREVO_API_KEY)  return { ok: false, status: 'failed', reason: 'no_api_key', provider: 'brevo' };
    if (!env.SMS_SENDER_ID)  return { ok: false, status: 'failed', reason: 'no_sender_id', provider: 'brevo' };

    // Brevo requires the recipient in international format with country code
    // and no '+', and a sender of at most 11 alphanumeric characters.
    const recipient = to.replace(/^\+/, '');
    try {
      const res = await fetch('https://api.brevo.com/v3/transactionalSMS/send', {
        method: 'POST',
        headers: {
          'api-key': env.BREVO_API_KEY,
          'content-type': 'application/json',
          'accept': 'application/json'
        },
        body: JSON.stringify({
          sender: env.SMS_SENDER_ID,
          recipient,
          content: text,
          type: 'Transactional',
          tag
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // Log the provider's error code, never the recipient or the message.
        console.error('sms: brevo rejected the send:', data && data.code);
        return { ok: false, status: 'failed', reason: 'provider_error', provider: 'brevo' };
      }
      return { ok: true, status: 'sent', id: String((data && data.messageId) || ''), provider: 'brevo' };
    } catch (e) {
      console.error('sms: brevo request failed');
      return { ok: false, status: 'unknown', reason: 'network_error', provider: 'brevo' };
    }
  }

  if (provider === 'thsms') {
    // THSMS v2 REST: a plain send-SMS API. It does NOT generate or verify
    // codes, so Luma stays the only system that does — exactly one OTP
    // implementation, per the round-1 design.
    //
    // Contract: https://www.thsms.com/sms-api (V2 Send SMS).
    // Provider acceptance is not proof of handset delivery. Live delivery
    // must still be verified before enabling Production OTP recovery.
    if (!env.THSMS_API_KEY) return { ok: false, status: 'failed', reason: 'no_api_key', provider: 'thsms' };
    if (!env.SMS_SENDER_ID) return { ok: false, status: 'failed', reason: 'no_sender_id', provider: 'thsms' };
    // LUMA passes +66; the documented V2 request uses local Thai numbers.
    const recipient = String(to || '').replace(/^\+?66/, '0');
    if (!/^0\d{9}$/.test(recipient)) return { ok: false, status: 'failed', reason: 'invalid_recipient', provider: 'thsms' };
    try {
      const res = await fetch('https://thsms.com/api/send-sms', {
        method: 'POST',
        // workerd rejects redirect:'error' before making any request.
        // Manual mode keeps credentials from being forwarded to another URL.
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
        headers: {
          'Authorization': `Bearer ${env.THSMS_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          msisdn: [recipient],
          message: text,
          sender: env.SMS_SENDER_ID
        })
      });
      if (res.status >= 300 && res.status < 400) {
        return { ok: false, status: 'unknown', reason: 'unexpected_redirect', provider: 'thsms' };
      }
      const data = await res.json().catch(() => null);
      // A server error or unreadable reply can follow a successful send.
      // Keep that uncertainty; never retry automatically or log the reply.
      if (res.status >= 500 || res.status === 408) {
        return { ok: false, status: 'unknown', reason: 'provider_unavailable', provider: 'thsms' };
      }
      if (!res.ok || data?.success === false) {
        return { ok: false, status: 'failed', reason: 'provider_error', provider: 'thsms' };
      }
      if (data?.success !== true || data?.code !== 200) {
        return { ok: false, status: 'unknown', reason: 'invalid_response', provider: 'thsms' };
      }
      // V2 does not promise a message ID in its documented success response.
      return { ok: true, status: 'sent', provider: 'thsms' };
    } catch (e) {
      // Only fixed diagnostic labels: never log exception messages, which
      // can contain headers, the recipient or message text.
      const reason = e?.name === 'TimeoutError' ? 'request_timeout'
        : e?.name === 'AbortError' ? 'request_aborted'
        : e?.name === 'TypeError' ? 'request_type_error'
        : 'network_error';
      console.error('sms: thsms request failed (' + reason + ')');
      return { ok: false, status: 'unknown', reason, provider: 'thsms' };
    }
  }

  console.error('sms: unknown provider configured — refusing to send');
  return { ok: false, status: 'failed', reason: 'unknown_provider', provider };
}
