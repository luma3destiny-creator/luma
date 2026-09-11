// netlify/functions/pay.js
// สร้าง Omise PromptPay charge → คืน chargeId + QR code URL

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  if (!process.env.OMISE_SECRET_KEY) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Payment service not configured' })
    };
  }

  const auth = Buffer.from(process.env.OMISE_SECRET_KEY + ':').toString('base64');

  try {
    const res = await fetch('https://api.omise.co/charges', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: 4900,       // 4900 สตางค์ = ฿49
        currency: 'thb',
        source: { type: 'promptpay' }
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('Omise error:', data);
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: data.message || 'ระบบชำระเงินขัดข้อง กรุณาลองใหม่' })
      };
    }

    const qrCodeUrl = data.source?.scannable_code?.image?.download_uri || null;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        chargeId: data.id,
        qrCodeUrl: qrCodeUrl,
        amount: 2900
      })
    };
  } catch (e) {
    console.error('Pay function error:', e);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'ไม่สามารถเชื่อมต่อระบบชำระเงิน กรุณาลองใหม่' })
    };
  }
};
