// test-api.js — Run with: node test-api.js YOUR_ANTHROPIC_API_KEY
const apiKey = process.argv[2];
if (!apiKey) { console.error('Usage: node test-api.js YOUR_API_KEY'); process.exit(1); }

const payload = {
  model: 'claude-haiku-4-5',
  max_tokens: 1500,
  messages: [
    {
      role: 'user',
      content: `คุณเป็นนักดูดวงที่พูดจาเป็นกันเอง ตรงไปตรงมา และมองโลกในแง่บวก
เขียนดวงชะตาส่วนตัวสำหรับ ทดสอบ โดยใช้ข้อมูลโหราศาสตร์ต่อไปนี้:

ดาวและตำแหน่ง:
- ดวงอาทิตย์ (ตัวตนหลัก): ราศีพฤษภ
- ดวงจันทร์ (ความรู้สึกภายใน): ราศีมีน
- ลัคนา (หน้าตาต่อคนอื่น): ราศีกรกฎ
- จุดสูงสุดของดวง (เส้นทางชีวิต/งาน): ราศีเมษ
- ดาวศุกร์ (ความรักและเสน่ห์): ราศีเมษ
- เรือนการเงิน: ราศีสิงห์
- เรือนสุขภาพ: ราศีธนู
- จุดพัฒนา (ราหู): ราศีเมษ
- จุดปล่อยวาง (เกตุ): ราศีตุลย์
- ดาวจิตวิญญาณ (เนปจูน): ราศีมีน
- ธาตุเด่นในปาจื่อ: ดิน
- ธาตุแห่งทรัพย์: น้ำ
- ธาตุที่ขาดและควรเสริม: ไฟ

เขียน 5 หมวดนี้ แต่ละหมวด 3-4 ประโยค:
1. งาน 2. เงิน 3. สุขภาพ 4. ความรัก 5. จิตวิญญาณ

กฎสำคัญ:
- ห้ามพูดถึงชื่อดาวหรือศัพท์โหราศาสตร์ในคำตอบ
- ใช้ภาษาไทยที่เป็นธรรมชาติ ไม่เป็นทางการ
- ตอบเป็น JSON รูปแบบนี้เท่านั้น ไม่มีข้อความอื่น:
{"career":"...","money":"...","health":"...","love":"...","spirit":"..."}`
    },
    { role: 'assistant', content: '{' }
  ]
};

(async () => {
  console.log('Calling Anthropic API...\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  console.log('HTTP status:', res.status);
  console.log('Raw response:\n', JSON.stringify(data, null, 2));

  if (!res.ok) { console.error('\nAPI Error!'); process.exit(1); }

  const rawText = '{' + data.content[0].text.trim();
  console.log('\n--- Raw text from Claude ---\n', rawText.slice(0, 500));

  const match = rawText.match(/\{[\s\S]*\}/);
  if (!match) { console.error('\nNo JSON found in response!'); process.exit(1); }

  try {
    const reading = JSON.parse(match[0]);
    console.log('\n✅ JSON parse OK!\n');
    console.log('career:', reading.career?.slice(0,80));
    console.log('money:', reading.money?.slice(0,80));
    console.log('health:', reading.health?.slice(0,80));
    console.log('love:', reading.love?.slice(0,80));
    console.log('spirit:', reading.spirit?.slice(0,80));
  } catch(e) {
    console.error('\n❌ JSON parse failed:', e.message);
    console.error('Attempted to parse:', match[0].slice(0, 200));
  }
})();
