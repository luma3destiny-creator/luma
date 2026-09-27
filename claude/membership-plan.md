# LUMA — ระบบสมาชิก LINE / Google

สถานะ 27 ก.ย. 2026: มี migration ฐานบัญชี, OAuth start/callback ของ LINE/Google, session/me/logout และหน้า /member ในเครื่อง ยังไม่ได้ขึ้น Preview/Production หรือทดสอบบัญชี provider จริง
ผู้ใช้อนุมัติให้เริ่มงานระบบสมาชิก และขอแผนพร้อมโมเดลก่อนเปลี่ยนงาน

## ผลที่ต้องได้

LINE หรือ Google → บัญชี LUMA กลาง → กรอกข้อมูลเกิดครั้งแรก → หน้าดวงของฉัน/รายงานที่ซื้อ
กลับมาเข้าใช้งานด้วยบัญชีเดิมแล้วเปิดผลเก่าได้ ไม่ต้องใช้ SMS สำหรับการสมัครทั่วไป
ดวงคู่แยกข้อมูลอีกคนออกจากเจ้าของบัญชี; การใช้ AI วิเคราะห์ยังไม่เปลี่ยนในงานนี้

## สำรวจแล้ว

- [x] schema.sql ปัจจุบันมี payments ผูก phone/token และ age_at_purchase; ตั้งใจไม่เก็บ birthdate ใน payments
- [x] check-access.js ยังรองรับ token และทางกู้คืนด้วยเบอร์ที่ควบคุมด้วย OTP_RECOVERY_ENABLED
- [x] paid-access.mjs ตรวจ paid + expires_at จาก payment token; login ใหม่ต้องไม่ถูกตีความว่าได้รับสิทธิ์จ่ายเงินทันที
- [x] ผู้ใช้ยืนยันได้รับ SMS แล้ว แต่การ verify รอบล่าสุดพบ wrong/expired code; ค่า True ค้างไม่ใช่หลักฐานสำเร็จ
- [x] จัดลำดับสมาชิกก่อนคลังคำตีความ/กระเป๋าดาวตามคำสั่งล่าสุด

## 1. บัญชีกลางและแบบข้อมูล — Astra High

- [x] กำหนดบัญชี LUMA กลางเป็นเจ้าของข้อมูล ไม่ใช้เบอร์หรืออีเมลเป็นกุญแจหลัก
- [ ] สร้าง migration เพิ่มตาราง และทดสอบกับ SQLite/D1 Preview ก่อนใช้จริง
- [x] schema users ในเครื่อง: รหัสสมาชิก สถานะ วันที่สร้าง/แก้ไข (การสุ่มรหัสจะทำใน service)
- [x] schema auth_identities ในเครื่อง: user_id, provider, provider_subject; UNIQUE(provider, provider_subject) และหนึ่งตัวตนต่อ provider ต่อบัญชี
- [x] schema member_sessions ในเครื่อง: hash ของ token, user_id, expires_at, revoked_at (ยังไม่มี cookie/session service)
- [ ] oauth_transactions: state/nonce, PKCE ตาม flow, ผูกกับเบราว์เซอร์และ provider, intent login/link, อายุสั้นและใช้ครั้งเดียว
- [ ] birth_profiles: เจ้าของบัญชี วัน/เวลา/สถานที่/เขตเวลาเกิดเท่าที่จำเป็น, รองรับไม่ทราบเวลา, เวอร์ชันข้อมูล
- [ ] payment_owners: เชื่อม payment_id กับ user_id แบบหนึ่งเจ้าของต่อรายการ เพื่อเพิ่มแบบไม่ทำลายข้อมูลเดิม
- [ ] reports: user_id, profile/version, report_type, content/version, entitlement reference; ข้อมูลรายงานอ่านได้เฉพาะเจ้าของ

แบบตารางเป็นข้อเสนอ ยังไม่ใช่ schema ที่ติดตั้งแล้ว ตรวจชื่อและลำดับ migration ที่ใช้จริงอีกครั้งก่อนเขียน

งานที่เขียนแล้ว: migrations/011_membership_core.sql เพิ่ม 3 ตารางข้างต้น ไม่แก้ payments; tests/membership/schema.mjs ผ่าน 6 tests บน SQLite จริงในเครื่อง รวมป้องกัน identity ซ้ำ, orphan, session lifetime ผิด, รักษาข้อมูล payments และการแยกเจ้าของ ยังต้องทดสอบ D1 Preview และตรวจ schema drift ก่อนนำไปใช้จริง

## 2. ตั้งค่า LINE และ Google — Luna Medium พาผู้ใช้ทำ

- [ ] สร้าง LINE Login channel สำหรับเว็บในบัญชีเจ้าของธุรกิจ
- [ ] ตั้งค่า Google OAuth client / consent screen ตามการใช้งานจริง
- [ ] ระบุ canonical host เดียวสำหรับ login/session; เสนอ www.lumahoro.com เนื่องจาก flow ทดสอบใช้ที่นี่ แต่ต้องตรวจระบบชำระเงินและ redirect ที่มีอยู่ก่อนใช้
- [ ] แยก app credentials และ callback ของ Preview/Production; Preview ไม่ใช้ Production DB
- [ ] เก็บ secrets ใน Cloudflare โดยผู้ใช้กรอกเอง ไม่ส่งในแชต ไม่ใส่ใน client bundle
- [ ] ขอสิทธิ์ข้อมูลเท่าที่ใช้จริง; ไม่บังคับ LINE email และไม่สมมติว่าจะได้รับเบอร์/วันเกิดจาก provider

ต้องมี credentials และ test accounts จริงก่อนทดสอบ login จริง แต่ไม่ขวางการสร้างและทดสอบในเครื่อง

## 3. สมัคร ล็อกอิน และ session — Astra High สำหรับส่วน authentication

- [x] auth start/callback ของ LINE และ Google ในเครื่อง: authorization code + PKCE, POST start + Origin check, fixed callback; แยกจากการ link บัญชี
- [x] ตรวจ Google JWT ผ่าน jose/JWKS และ LINE ผ่าน verify endpoint พร้อมตรวจ claims; state ผูกคุกกี้และใช้ได้ครั้งเดียว ทดสอบจำลองแล้ว
- [ ] สร้างหรือค้นบัญชีด้วย provider_subject; ใช้ unique constraint กัน callback พร้อมกันสร้างบัญชีซ้ำ
- [x] session cookie __Host- Secure/HttpOnly/SameSite=Lax, hash ใน DB, อายุ 7 วัน, ตรวจ active user/expiry/revoke, logout ฝั่งเซิร์ฟเวอร์ ในเครื่อง
- [ ] ป้องกัน CSRF ของการแก้ไขข้อมูล ตรวจ Origin และไม่เปิด credentialed CORS กว้าง ๆ
- [x] เส้นทาง current member/logout และ start rate limit ในเครื่อง ไม่เผย raw error/provider tokens
- [ ] profile API และการกำหนดสิทธิ์ข้อมูลเกิด
- [ ] ไม่เก็บ OAuth access/refresh token ถ้าไม่จำเป็นต่อการใช้งาน

## 4. ข้อมูลเกิดและหน้าสมาชิก — Sol Medium

- [ ] สมัครครั้งแรก → ฟอร์มข้อมูลเกิด; login ครั้งต่อไป → หน้าของฉัน
- [ ] ย้ายข้อมูลที่ผู้ใช้กรอกระหว่างดูเว็บเข้าโปรไฟล์อย่างชัดเจน ไม่เปลี่ยนเจ้าของตามชื่อหรืออีเมล
- [ ] แก้ไขข้อมูลเกิดได้ พร้อมอธิบายว่ารายงานเก่าอ้างข้อมูลเวอร์ชันเดิม ไม่สร้าง AI ใหม่หรือคิดเงินโดยอัตโนมัติ
- [ ] หน้า “ผลดวงของฉัน”, “รายงานที่ซื้อ”, “บัญชีที่เชื่อม”, ออกจากระบบ
- [ ] ตรวจสิทธิ์เจ้าของทุก API; ห้ามใช้ user_id จาก request เป็นหลักฐานว่าเป็นเจ้าของ
- [ ] ปรับข้อความความเป็นส่วนตัวให้ตรงกับการบันทึกข้อมูลเกิด/รายงาน มีวิธีแก้ไขและลบข้อมูลตามขอบเขตบริการ

ข้อมูลเกิดใหม่อยู่ในโปรไฟล์ ไม่คืน birthdate ลง payments หรือย้อนสร้างจาก age_at_purchase

## 5. เชื่อมผู้ซื้อเดิมและ provider ที่สอง — Astra High

- [ ] ผู้ใช้ต้อง login ก่อน แล้วเลือก “เชื่อมสิทธิ์ที่เคยซื้อ”
- [ ] OTP claim ต้องผูกกับ user/session/phone/purpose ของคำขอนั้น อายุสั้น ใช้ครั้งเดียว และทดสอบ verify ให้ผ่านก่อนใช้งาน
- [ ] เชื่อม payment แบบ atomic; หนึ่งรายการห้ามถูกยึดโดยอีกบัญชีหรือถูก claim ซ้ำพร้อมกัน
- [ ] ไม่ใช้ token ที่เคยได้จากทาง phone-only เป็นหลักฐานเพียงอย่างเดียวในการย้ายสิทธิ์
- [ ] การเชื่อม LINE/Google ตัวที่สองต้องเริ่มจาก session ที่ยืนยันแล้วและยืนยัน provider ใหม่; ถ้าเป็นของอีกบัญชีให้หยุด ไม่ merge อัตโนมัติจาก email/name
- [ ] ปรับ pay/webhook/paid-access ให้รับเจ้าของบัญชีจาก server/session และตรวจผลชำระเงินจริง ป้องกันการแนบ user_id ของคนอื่น
- [ ] ก่อนเปิด claim จริง ปิดทางกู้คืนด้วยเบอร์อย่างเดียว และทดสอบว่า token เก่าไม่ข้ามขอบเขตเจ้าของได้

พักการเปิด OTP เป็น login หลักไว้ งานสมาชิกทั่วไปทำต่อได้ แต่การ claim สิทธิ์เดิมยังต้องรอ OTP ผ่านจริง

## 6. ทดสอบและเปิดใช้ — Sol High; Astra High ตรวจความปลอดภัยรอบสุดท้าย

- [ ] callback replay, state mismatch, token wrong audience/issuer/expired, account-link conflict
- [ ] ผู้ใช้ A อ่าน/แก้โปรไฟล์หรือรายงานของ B ไม่ได้; session หมดอายุและ logout ใช้ต่อไม่ได้
- [ ] payment webhook ซ้ำ/มาช้า และ OTP claim พร้อมกันไม่ทำให้สิทธิ์ผิดเจ้าของ
- [ ] ทดสอบด้วย workerd/D1-compatible runtime ไม่พึ่ง Node mock อย่างเดียว (บทเรียน redirect THSMS)
- [ ] ทดสอบ LINE/Google จริงบน Preview, มือถือ/desktop และการยกเลิก login
- [ ] ทดสอบ checkout/webhook/สิทธิ์ผู้ซื้อเดิมบนเส้นทางที่เหมาะสมก่อนเปิด Production
- [ ] เปิดเป็นระยะพร้อม feature flags และแนวย้อนกลับที่ไม่เปิดช่องทางยึดสิทธิ์เดิม

## ขอบเขตรุ่นแรก

รวม LINE/Google, โปรไฟล์เกิด, หน้าของฉัน, เจ้าของรายงานและสิทธิ์, เชื่อมผู้ซื้อเดิม
ไม่รวมกระเป๋าดาว แพ็กสมาชิกแบบรายเดือน การเปลี่ยนราคา และการเปลี่ยน AI ดูดวง ซึ่งอยู่ใน roadmap ระยะต่อไป

## โมเดลและการประหยัดงบ

คำแนะนำเฉพาะงานจาก model-switch-reminder และโมเดลที่มีใน Codex เครื่องนี้ ไม่ใช่การรับประกันราคา/โควตา:
- Astra High: ออกแบบ auth, account linking, ownership/payment authorization และ security review
- Sol Medium: พัฒนา UI/profile/report ตามแบบ; ยกระดับ High เมื่อมีบั๊กข้ามหลายส่วน
- Luna Medium: ขั้นตอน dashboard, checklist, สรุปสถานะ
ไม่ใช้ Max/Ultra เป็นค่าเริ่มต้น ไม่สลับโมเดลทุกขั้นเล็ก ๆ ไม่เรียก AI สดในการทดสอบ login
โมเดลเหล่านี้เป็นผู้ช่วยพัฒนาใน Codex ไม่ได้เปลี่ยนโมเดลบนเว็บไซต์ และยังไม่ได้สั่งเปลี่ยนโมเดลของงานนี้

อ้างอิง: https://developers.line.biz/en/docs/line-login/integrate-line-login/
https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6

## ความคืบหน้าการตั้งค่าโดยเจ้าของ
- [x] ภาพยืนยัน LINE Login channel LUMA, ID 2011754020, Provider LUMA, Thailand, Developing
- [x] ภาพยืนยัน Web app enabled และ callback https://www.lumahoro.com/api/auth/line/callback
- [x] เจ้าของยืนยันบันทึก LINE_CHANNEL_ID และ LINE_CHANNEL_SECRET ใน Cloudflare Production ตามขั้นตอนแล้ว; ไม่ได้อ่านค่า secret หรือทดสอบ credential
- [x] เจ้าของยืนยันตั้ง Google OAuth client, consent แบบ External, secrets ใน Cloudflare Production และเพิ่ม Test users แล้ว; ยังไม่ได้ตรวจค่า credential
- [x] LINE/Google callback implementation ในเครื่อง พร้อมทดสอบจำลอง
- [ ] Live login ยังไม่ทดสอบ; ยังไม่ publish channel หรือ Google app

## ผลตรวจ 27 ก.ย. 2026 และขั้นต่อไป

- [x] npm run test:membership: 16 tests ผ่าน ใช้ SQLite จริง + provider mocks + Google JWT ลงลายเซ็นด้วยกุญแจทดสอบ
- [x] workerd 1.20260926.1 smoke ผ่าน 8 assertions: routing imports, start/PKCE, me/logout, callback reject, Google JWT และ LINE requests แบบ mock ที่ใช้ Request จริงของ workerd
- [x] node build.mjs ผ่าน 5 public files; เพิ่มเฉพาะ member.html ใน allowlist
- [ ] D1 Preview migrations และทดสอบ actual bindings/transactions ยังไม่ทำ; workerd smoke ใช้ DB stub จึงไม่ใช่หลักฐานว่า D1 ผ่าน
- [ ] ทดสอบหน้าเว็บบนมือถือและ browser กับ provider จริง

ไฟล์ใหม่หลัก: migrations/011_membership_core.sql, migrations/012_oauth_transactions.sql, functions/lib/member-*.mjs, functions/api/auth/, member.html, tests/membership/, package.json และ package-lock.json
Dependency jose 6.2.12; esbuild 0.28.2 ใช้สำหรับ runtime smoke bundle. ไม่เปลี่ยน package type เพื่อไม่กระทบ Netlify CommonJS เดิม

ตั้ง MEMBERSHIP_ENABLED=true เฉพาะ Preview เมื่อ DB/credentials พร้อม และ AUTH_ORIGIN เป็น https://<ชื่อโฮสต์ Preview คงที่> แบบ origin เท่านั้น ทั้ง start และ callback ต้องอยู่ host นี้
Production ยังไม่ตั้ง true. Credentials Production ที่เจ้าของบันทึกไว้ไม่ทำให้ endpoints เปิดเอง
ต้องเลือกหรือสร้าง D1 Preview แยกจาก luma-db; ผูก DB ใน Preview; ควรแยก LINE/Google test credentials และลงทะเบียน Preview callback ให้ตรง host ก่อน live test
เมื่อจะเผยแพร่ ใช้ checkout แยกจาก main ล่าสุด ห้าม push งานที่ค้างทั้ง branch ปัจจุบันซึ่งมีงานอื่นรวมอยู่
ยังไม่มีข้อมูลเกิด/ประวัติ/paid ownership/OTP claim/account linking; หน้า member แสดงสถานะเข้าสู่ระบบและบอกว่าฟีเจอร์เหล่านี้ยังเตรียมอยู่
