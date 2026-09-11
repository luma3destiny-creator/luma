// functions/api/omise-webhook.js — Cloudflare Pages Function

export async function onRequestPost(context) {
  const { request, env } = context;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  if (payload.key === 'charge.complete' && payload.data?.status === 'successful') {
    const chargeId = payload.data.id;

    if (chargeId && env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
      try {
        const key = encodeURIComponent('token:' + chargeId);
        const redisUrl = `${env.UPSTASH_REDIS_REST_URL}/set/${key}/paid/EX/900`;

        await fetch(redisUrl, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
        });
      } catch (e) {
        console.error('Redis error:', e);
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
