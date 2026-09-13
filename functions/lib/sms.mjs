// functions/lib/sms.mjs — the one place that knows how to send an SMS.
//
// Deliberately a thin adapter: which provider we use for Thai OTP is NOT
// settled (see the notes in the round-1 report — Brevo lists Thailand as a
// supported destination but publishes no Thailand-specific sender/registration
// guidance, and no per-message price). Keeping the provider behind this
// interface means swapping it is a one-file change, not a rewrite.
//
// env.SMS_PROVIDER selects the implementation:
//   'mock'  — records the message, sends nothing. The default, and the only
//             value that should ever be set in Preview until real sending has
//             been signed off. Costs nothing.
//   'brevo' — Brevo transactional SMS.
//
// Nothing here ever sends unless SMS_PROVIDER is explicitly set to a real
// provider, so a missing config can never silently start spending money.

export const SMS_MOCK_OUTBOX = [];   // test-visible; empty in production workers

/**
 * @returns {{ok:true, id:string, provider:string} | {ok:false, reason:string}}
 */
export async function sendSms(env, { to, text, tag = 'luma-otp' }) {
  const provider = (env.SMS_PROVIDER || 'mock').toLowerCase();

  if (provider === 'mock') {
    // Never leave the message body in a log line — an OTP is a credential.
    SMS_MOCK_OUTBOX.push({ to, text, tag, at: new Date().toISOString() });
    console.log('sms: mock provider — nothing sent');
    return { ok: true, id: 'mock-' + SMS_MOCK_OUTBOX.length, provider: 'mock' };
  }

  if (provider === 'brevo') {
    if (!env.BREVO_API_KEY)  return { ok: false, reason: 'no_api_key' };
    if (!env.SMS_SENDER_ID)  return { ok: false, reason: 'no_sender_id' };

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
        return { ok: false, reason: 'provider_error' };
      }
      return { ok: true, id: String((data && data.messageId) || ''), provider: 'brevo' };
    } catch (e) {
      console.error('sms: brevo request failed');
      return { ok: false, reason: 'network_error' };
    }
  }

  console.error('sms: unknown provider configured — refusing to send');
  return { ok: false, reason: 'unknown_provider' };
}
