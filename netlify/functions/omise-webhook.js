// netlify/functions/omise-webhook.js
// รับ Omise webhook เมื่อจ่ายเงินสำเร็จ → เก็บ token ใน Upstash Redis

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Bad Request' };
  }

  console.log('Omise webhook event:', payload.key, payload.data?.id, payload.data?.status);

  // รับเฉพาะ charge.complete ที่สำเร็จ
  if (payload.key === 'charge.complete' && payload.data?.status === 'successful') {
    const chargeId = payload.data.id;

    if (chargeId && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      try {
        // เก็บ token ใน Redis 15 นาที (900 วินาที)
        const key = encodeURIComponent('token:' + chargeId);
        const redisUrl = `${process.env.UPSTASH_REDIS_REST_URL}/set/${key}/paid/EX/900`;

        const redisRes = await fetch(redisUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`
          }
        });

        if (redisRes.ok) {
          console.log('Token stored for charge:', chargeId);
        } else {
          const errText = await redisRes.text();
          console.error('Redis store failed:', errText);
        }
      } catch (e) {
        console.error('Redis error:', e);
      }
    }
  }

  // ต้อง return 200 เสมอ ไม่งั้น Omise จะส่ง webhook ซ้ำ
  return {
    statusCode: 200,
    body: JSON.stringify({ received: true })
  };
};
