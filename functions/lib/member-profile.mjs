import { authOrigin, sameOrigin, json, currentMember, nowSeconds } from './member-session.mjs';
import { isRealCalendarDate, toBangkokYmd } from './age.mjs';
import { VALID_PLACE_NAMES } from './birth-places.mjs';

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
    firstName: row.first_name ?? null,
    lastName: row.last_name ?? null,
    birthYear: row.birth_year,
    birthMonth: row.birth_month,
    birthDay: row.birth_day,
    birthHour: row.birth_hour,
    birthMinute: row.birth_minute,
    birthPlace: row.birth_place,
    gender: row.gender,
    timeUnknown: !!row.time_unknown,
    updatedAt: row.updated_at
  };
}

// Strict integer check on the RAW value, before any Number() coercion — Number(null),
// Number('') and Number(false) all silently become 0, which would let a missing/omitted
// field masquerade as a valid "00" hour/minute. Only an actual JS number that is already
// an integer (as sent by JSON, e.g. from JSON.stringify({ birthHour: 0 })) passes.
const isPlainInteger = (v) => typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v);

// Name fields are optional (existing accounts saved before this feature has none), but
// whatever IS provided must be a real, reasonably-sized string. An empty/blank string is
// treated the same as "not provided" (null), not as an error.
function normalizeName(v) {
  if (v === undefined || v === null) return { value: null };
  if (typeof v !== 'string') return { error: 'ชื่อ/นามสกุลไม่ถูกต้อง' };
  const trimmed = v.trim();
  if (trimmed === '') return { value: null };
  if (trimmed.length > 100) return { error: 'ชื่อ/นามสกุลยาวเกินไป' };
  return { value: trimmed };
}

// Validates the fields a birth profile actually needs (matches app.html's #birthForm:
// day/month/year/hour/minute/place/gender, plus name and the "don't remember birth time"
// checkbox added on top of it). Returns { value } or { error }.
function validateProfileInput(body) {
  if (!body || typeof body !== 'object') return { error: 'ข้อมูลไม่ถูกต้อง' };
  const { birthYear: year, birthMonth: month, birthDay: day, birthPlace, gender, firstName, lastName } = body;
  // Strict boolean only — anything else (including a truthy string) means "remembers the time".
  const timeUnknown = body.timeUnknown === true;
  const place = typeof birthPlace === 'string' ? birthPlace.trim() : '';

  if (![year, month, day].every(isPlainInteger)) return { error: 'กรุณากรอกวัน เดือน ปีเกิดให้ครบ' };
  if (!isRealCalendarDate(year, month, day)) return { error: 'วัน เดือน ปีเกิด ไม่ใช่วันที่จริงในปฏิทิน' };
  if (year < 1900 || year > 2100) return { error: 'ปีเกิดต้องอยู่ระห้าง 1900–2100' };

  // When the customer doesn't remember their birth time, the server ALWAYS uses 12:00 as
  // the estimate and never trusts an hour/minute sent from the browser for that case.
  let hour, minute;
  if (timeUnknown) {
    hour = 12; minute = 0;
  } else {
    ({ birthHour: hour, birthMinute: minute } = body);
    if (![hour, minute].every(isPlainInteger)) return { error: 'กรุณากรอกเวลาเกิดให้ครบ หรือติ๊ก "จำเวลาเกิดไม่ได้"' };
    if (hour < 0 || hour > 23) return { error: 'เวลาเกิด (ชั่วโมง) ไม่ถูกต้อง' };
    if (minute < 0 || minute > 59) return { error: 'เวลาเกิด (นาที) ไม่ถูกต้อง' };
  }

  if (!place) return { error: 'กรุณาเลือกสถานที่เกิด' };
  // Restricted to the exact place list #bplace (app.html) and #pPlace (member.html)
  // both populate their dropdown from — this is what lets /app's auto-view flow trust
  // a saved place will always resolve to a real lat/lng/timezone, with no guessing.
  // Rows saved before this check existed may hold an older free-text value outside this
  // list; those are left as-is here and are handled client-side by asking the member to
  // reselect once (isKnownPlace() in app.html), never by rejecting or silently guessing.
  if (!VALID_PLACE_NAMES.has(place)) return { error: 'กรุณาเลือกสถานที่เกิดจากรายการที่ระบบรองรับ' };
  if (gender !== 'm' && gender !== 'f') return { error: 'กรุณาเลือกเพศกำเนิด' };

  const first = normalizeName(firstName);
  if (first.error) return { error: first.error };
  const last = normalizeName(lastName);
  if (last.error) return { error: last.error };

  // Reject future birthdates, compared as a calendar date in Asia/Bangkok (same fixed
  // UTC+7 convention age.mjs already uses for payments — no timezone database needed).
  const today = toBangkokYmd(new Date());
  const isFuture = (year > today.y) || (year === today.y && month > today.m) ||
    (year === today.y && month === today.m && day > today.d);
  if (isFuture) return { error: 'วันเกิดต้องไม่ใช่วันในอนาคต' };

  return { value: { year, month, day, hour, minute, place, gender, timeUnknown, firstName: first.value, lastName: last.value } };
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
        (user_id, birth_year, birth_month, birth_day, birth_hour, birth_minute, birth_place, gender,
         first_name, last_name, time_unknown, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        birth_year=excluded.birth_year, birth_month=excluded.birth_month, birth_day=excluded.birth_day,
        birth_hour=excluded.birth_hour, birth_minute=excluded.birth_minute, birth_place=excluded.birth_place,
        gender=excluded.gender, first_name=excluded.first_name, last_name=excluded.last_name,
        time_unknown=excluded.time_unknown, updated_at=excluded.updated_at`)
      .bind(member.id, value.year, value.month, value.day, value.hour, value.minute, value.place, value.gender,
        value.firstName, value.lastName, value.timeUnknown ? 1 : 0, now, now)
      .run();
    const row = await env.DB.prepare('SELECT * FROM birth_profiles WHERE user_id=?').bind(member.id).first();
    return json({ ok: true, profile: toProfileJson(row) });
  } catch { return unavailable(); }
}
