// test-models.js — node test-models.js YOUR_API_KEY
const apiKey = process.argv[2];
if (!apiKey) { console.error('Usage: node test-models.js YOUR_API_KEY'); process.exit(1); }

const MODELS = [
  { id: 'claude-haiku-4-5',            label: 'Haiku 4.5 (ใช้อยู่)' },
  { id: 'claude-3-5-haiku-20241022',   label: 'Haiku 3.5' },
  { id: 'claude-3-haiku-20240307',     label: 'Haiku 3' },
  { id: 'claude-sonnet-4-5',           label: 'Sonnet 4.5' },
  { id: 'claude-3-5-sonnet-20241022',  label: 'Sonnet 3.5' },
];

const prompt = `คุณเป็นนักดูดวงชาวไทยที่พูดจาตรงไปตรงมา เป็นกันเอง และไม่โอ้อวด
เขียนคำทำนายสำหรับ "วีรวัต" จากข้อมูลดาวด้านล่าง

ข้อมูลดาว:
ดวงอาทิตย์=พฤษภ, ดวงจันทร์=มีน, ลัคนา=กรกฎ, จุดสูงสุด=เมษ
ดาวศุกร์=เมษ, เรือนที่2=สิงห์, เรือนที่6=ธนู
ราหู=เมษ, เกตุ=ตุลย์, เนปจูน=มีน
ธาตุเด่น=ดิน, ธาตุทรัพย์=น้ำ, ธาตุที่ต้องเสริม=ไฟ

เขียน 5 หัวข้อ หัวข้อละ 3-4 ประโยค ใช้ภาษาพูดไทยธรรมดา ไม่ใช้ศัพท์โหราศาสตร์
ตอบเป็น JSON เท่านั้น:
{"career":"...","money":"...","health":"...","love":"...","spirit":"..."}`;

async function testModel(model) {
  const start = Date.now();
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model: model.id, max_tokens: 1500, messages: [{ role:'user', content: prompt }] })
    });
    const data = await res.json();
    const elapsed = Date.now() - start;

    if (!res.ok) return { model, elapsed, ok: false, error: data.error?.message || JSON.stringify(data) };

    const usage = data.usage || {};
    const rawText = data.content[0].text.trim();
    const jsonMatch = rawText.match(/\{[\s\S]*"spirit"[\s\S]*\}/);
    if (!jsonMatch) return { model, elapsed, ok: false, error: 'ไม่มี JSON', raw: rawText.slice(0,100) };

    let reading;
    try { reading = JSON.parse(jsonMatch[0]); } 
    catch(e) { return { model, elapsed, ok: false, error: 'JSON parse fail', raw: rawText.slice(0,100) }; }

    return { model, elapsed, ok: true, usage, career: reading.career?.slice(0,80), money: reading.money?.slice(0,80) };
  } catch(e) {
    return { model, elapsed: Date.now()-start, ok: false, error: e.message };
  }
}

(async () => {
  console.log('Testing', MODELS.length, 'models...\n');
  const results = [];
  for (const m of MODELS) {
    process.stdout.write(`Testing ${m.label}... `);
    const r = await testModel(m);
    results.push(r);
    console.log(r.ok ? `✅ ${r.elapsed}ms` : `❌ ${r.error}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('RESULTS');
  console.log('='.repeat(80));
  for (const r of results) {
    console.log(`\n[${r.model.label}] (${r.model.id})`);
    if (!r.ok) { console.log('  ERROR:', r.error); continue; }
    console.log(`  เวลา: ${r.elapsed}ms | tokens in: ${r.usage.input_tokens} out: ${r.usage.output_tokens}`);
    console.log(`  งาน: ${r.career}`);
    console.log(`  เงิน: ${r.money}`);
  }
  
  // write JSON for artifact
  const fs = await import('fs');
  fs.writeFileSync('/tmp/model-results.json', JSON.stringify(results, null, 2));
  console.log('\n\nSaved to /tmp/model-results.json');
})();
