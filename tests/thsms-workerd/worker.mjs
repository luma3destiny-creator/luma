// Run workerd serve tests/thsms-workerd/config.capnp, then GET localhost:8899.
// All provider fetches are stubbed. No secrets or SMS are used.
import { sendSms } from 'sms.mjs';

export default {
  async fetch() {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    let rejectedOldMode = false;
    try {
      new Request('https://example.invalid', { redirect: 'error' });
    } catch { rejectedOldMode = true; }
    globalThis.fetch = async (url, options) => {
      calls++;
      // Use the REAL Cloudflare Request constructor, not Node's implementation.
      const request = new Request(url, options);
      if (request.redirect !== 'manual') throw new Error('Unsafe redirect mode');
      return Response.json({ success: true, code: 200 });
    };
    try {
      const result = await sendSms(
        { SMS_PROVIDER: 'thsms', SMS_SENDER_ID: 'SMSOTP', THSMS_API_KEY: 'fake-key' },
        { to: '+66900000000', text: 'Test only' }
      );
      const ok = result.ok && result.status === 'sent' && calls === 1;
      return Response.json({ ok, rejectedOldMode, calls, result }, { status: ok ? 200 : 500 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
};
