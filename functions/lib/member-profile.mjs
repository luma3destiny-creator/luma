import { authOrigin, sameOrigin, json, currentMember, nowSeconds } from './member-session.mjs';
import { isRealCalendarDate, toBangkokYmd } from './age.mjs';

const unavailable = () => json({ ok: false, error: 'ระบบสมาชิกยังไม่พร้อมใช้งาน' }, 503);
const invalid = (message) => json({ ok: false, error: message || 'ข้อมูลไม่ถูกต้อง' }, 400);
const unauthenticated = () => json({ ok: false, error: 'กรุณาเข้าสู่ระบบก่อน' }, 401);

const MAX_BODY_BYTES = 8 * 1024;

async function readJson(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function toProfileJson(row) {
  if (!row) return null;
  return {
    birthYear: row.birth_year,
    birthMonth: row.birth_month,
    birthDay: row.birth_day,
    birthHour: row.birth_hour,
    birthMinute: row.birth_minute,
    birthPlace: row.birth_place,
    gender: row.gender,
    updatedAt: row.updated_at
  };
}

// Strict integer check on the RAW value, before any Number() coercion — Number(null),
// Number('') and Number(false) all silently become 0, which would let a missing/omitted
// field masquerade as a valid "00" hour/minute. Only an actual JS number that is already
// an integer (as sent by JSON, e.g. from JSON.stringify({ birthHour: 0 })) passes.
const isPlainInteger = (v) => typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v);

// Validates the seven fields a birth profile actually needs (matches app.html's #birthForm:
// day/month/year/hour/minute/place/gender). Returns { value } or { error }.
function validateProfileInput(body) {
  if (!body || typeof body !== 'object') return { error: 'ข้อมูลไม่ถูกต้อง' };
  const { birthYear: year, birthMonth: month, birthDay: day, birthHour: hour, birthMinute: minute, birthPlace, gender } = body;
  const place = typeof birthPlace === 'string' ? birthPlace.trim() : '';

  if (![year, month, day, hour, minute].every(isPlainInteger)) return { error: 'กรุณากรอกวัน เดือน ปี และเวลาเกิดให้ครบ' };
  if (!isRealCalendarDate(year, month, day)) return { error: 'วัน เดือน ปีเกิด ไม่ใช่วันที่จริงในปฏิทิน' };
  if (year < 1900 || year > 2100) return { error: 'ปีเกิดต้องอยู่ระห้าง 1900–2100' };
  if (hour < 0 || hour > 23) return { error: 'เวลาเกิด (ชั่วโมง) ไม่ถูกต้อง' };
  if (minute < 0 || minute > 59) return { error: 'เวลาเกิด (นาที) ไม่ถูกต้อง' };
  if (!place || place.length > 200) return { error: 'กรุณากรอกสถานที่เกิด' };
  if (gender !== 'm' && gender !== 'f') return { error: 'กรุณาเลือกเพศกำเนิด' };

  // Reject future birthdates, compared as a calendar date in Asia/Bangkok (same fixed
  // UTC+7 convention age.mjs already uses for payments — no timezone database needed).
  const today = toBangkokYmd(new Date());
  const isFuture = (year > today.y) || (year === today.y && month > today.m) ||
    (year === today.y && month === today.m && day > today.d);
  if (isFuture) return { error: 'วันเกิดต้องไม่ใช่วันในอนาคต' };

  return { value: { year, month, day, hour, minute, place, gender } };
}

export async function getProfile({ env, request }) {
  if (!authOrigin(env, request)) return unavailable();
  try {
    const member = await currentMember(env, request);
    if (!member) return unauthenticated();
    const row = await env.DB.prepare('SELECT * FROM birth_profiles WHERE user_id=?').bind(member.id).first();
    return json({ ok: true, profile: toProfileJson(row) });
  } catch { return unavailable(); }
}

export async function saveProfile({ env, request }) {
  const origin = authOrigin(env, request);
  if (!origin) return unavailable();
  if (request.method !== 'POST' || !sameOrigin(request, origin)) return invalid('คำขอไม่ถูกต้อง กรุณาลองใหม่');
  try {
    const member = await currentMember(env, request);
    if (!member) return unauthenticated();
    const body = await readJson(request);
    const { value, error } = validateProfileInput(body);
    if (error) return invalid(error);
    const now = nowSeconds();
    await env.DB.prepare(`INSERT INTO birth_profiles
        (user_id, birth_year, birth_month, birth_day, birth_hour, birth_minute, birth_place, gender, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        birth_year=excluded.birth_year, birth_month=excluded.birth_month, birth_day=excluded.birth_day,
        birth_hour=excluded.birth_hour, birth_minute=excluded.birth_minute, birth_place=excluded.birth_place,
        gender=excluded.gender, updated_at=excluded.updated_at`)
      .bind(member.id, value.year, value.month, value.day, value.hour, value.minute, value.place, value.gender, now, now)
      .run();
    const row = await env.DB.prepare('SELECT * FROM birth_profiles WHERE user_id=?').bind(member.id).first();
    return json({ ok: true, profile: toProfileJson(row) });
  } catch { return unavailable(); }
}
