import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { getProfile, saveProfile } from '../../functions/lib/member-profile.mjs';
import { createMemberSession } from '../../functions/lib/member-session.mjs';

const origin = 'https://www.lumahoro.com';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  for (const name of ['011_membership_core.sql', '013_birth_profiles.sql']) {
    db.exec(readFileSync(new URL('../../migrations/' + name, import.meta.url), 'utf8'));
  }
  const prep = (sql, args = []) => ({
    bind: (...a) => prep(sql, a),
    first: () => db.prepare(sql).get(...args) || null,
    run: () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } })
  });
  const DB = { prepare: prep, batch: async stmts => {
    db.exec('BEGIN');
    try { const r = stmts.map(s => s.run()); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  } };
  const env = { DB, MEMBERSHIP_ENABLED: 'true', AUTH_ORIGIN: origin };
  return { db, env };
}
function request(path, { method = 'GET', cookie = '', same = true, body } = {}) {
  const headers = { Cookie: cookie, ...(method === 'POST' ? { Origin: same ? origin : 'https://evil.invalid' } : {}) };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; }
  return new Request(origin + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
async function signIn(env, subject) {
  return (await createMemberSession(env, 'line', subject, request('/'))).split(';')[0];
}
const sample = { birthYear: 1996, birthMonth: 4, birthDay: 12, birthHour: 7, birthMinute: 30, birthPlace: 'เชียงใหม่', gender: 'f' };

test('schema rejects out-of-range fields and non-real dates before the app layer even runs', t => {
  const { db } = fixture(t);
  db.prepare('INSERT INTO users(id) VALUES (?)').run('user-aaaaaaaaaaaaaaa');
  const insert = db.prepare(`INSERT INTO birth_profiles
    (user_id,birth_year,birth_month,birth_day,birth_hour,birth_minute,birth_place,gender,created_at,updated_at)
    VALUES ('user-aaaaaaaaaaaaaaa',?,?,?,?,?,?,?,100,100)`);
  assert.throws(() => insert.run(1996, 13, 1, 7, 30, 'x', 'f'), /CHECK/); // month 13
  assert.throws(() => insert.run(1996, 4, 12, 24, 30, 'x', 'f'), /CHECK/); // hour 24
  assert.throws(() => insert.run(1996, 4, 12, 7, 60, 'x', 'f'), /CHECK/); // minute 60
  assert.throws(() => insert.run(1996, 4, 12, 7, 30, '', 'f'), /CHECK/); // empty place
  assert.throws(() => insert.run(1996, 4, 12, 7, 30, 'x', 'other'), /CHECK/); // gender
  assert.throws(() => insert.run(1899, 4, 12, 7, 30, 'x', 'f'), /CHECK/); // year range
  insert.run(1996, 4, 12, 7, 30, 'x', 'f');
  assert.throws(() => db.prepare("INSERT INTO birth_profiles(user_id,birth_year,birth_month,birth_day,birth_hour,birth_minute,birth_place,gender,created_at,updated_at) VALUES ('nonexistent',1996,4,12,7,30,'x','f',100,100)").run(), /FOREIGN KEY/);
});

test('unauthenticated callers are rejected and never reach the database', async t => {
  const { env, db } = fixture(t);
  assert.equal((await getProfile({ env, request: request('/api/member/profile') })).status, 401);
  assert.equal((await saveProfile({ env, request: request('/api/member/profile', { method: 'POST', body: sample }) })).status, 401);
  assert.equal(db.prepare('SELECT count(*) AS n FROM birth_profiles').get().n, 0);
});

test('cross-origin save is rejected as CSRF and writes nothing', async t => {
  const { env, db } = fixture(t);
  const cookie = await signIn(env, 'subject-a');
  const response = await saveProfile({ env, request: request('/api/member/profile', { method: 'POST', cookie, same: false, body: sample }) });
  assert.equal(response.status, 400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM birth_profiles').get().n, 0);
});

test('a real calendar date is required before any write', async t => {
  const { env, db } = fixture(t);
  const cookie = await signIn(env, 'subject-a');
  for (const bad of [{ ...sample, birthDay: 30, birthMonth: 2 }, { ...sample, birthMonth: 13 }, { ...sample, birthHour: 24 }, { ...sample, birthPlace: '' }, { ...sample, gender: 'x' }]) {
    const response = await saveProfile({ env, request: request('/api/member/profile', { method: 'POST', cookie, body: bad }) });
    assert.equal(response.status, 400);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM birth_profiles').get().n, 0);
});

test('save then read-back round-trips exactly, and no profile shows null before saving', async t => {
  const { env } = fixture(t);
  const cookie = await signIn(env, 'subject-a');
  const empty = await (await getProfile({ env, request: request('/api/member/profile', { cookie }) })).json();
  assert.equal(empty.profile, null);
  const saved = await (await saveProfile({ env, request: request('/api/member/profile', { method: 'POST', cookie, body: sample }) })).json();
  assert.equal(saved.ok, true);
  assert.equal(saved.profile.birthPlace, 'เชียงใหม่');
  const read = await (await getProfile({ env, request: request('/api/member/profile', { cookie }) })).json();
  assert.deepEqual(
    { ...read.profile, updatedAt: undefined },
    { ...sample, updatedAt: undefined }
  );
});

test('editing an existing profile updates the same row rather than creating a second one', async t => {
  const { env, db } = fixture(t);
  const cookie = await signIn(env, 'subject-a');
  await saveProfile({ env, request: request('/api/member/profile', { method: 'POST', cookie, body: sample }) });
  const edited = { ...sample, birthHour: 15, birthPlace: 'กรุงเทพมหานคร' };
  await saveProfile({ env, request: request('/api/member/profile', { method: 'POST', cookie, body: edited }) });
  assert.equal(db.prepare('SELECT count(*) AS n FROM birth_profiles').get().n, 1);
  const read = await (await getProfile({ env, request: request('/api/member/profile', { cookie }) })).json();
  assert.equal(read.profile.birthHour, 15);
  assert.equal(read.profile.birthPlace, 'กรุงเทพมหานคร');
});

test('two accounts never see or overwrite each other\'s birth data', async t => {
  const { env } = fixture(t);
  const cookieA = await signIn(env, 'subject-a');
  const cookieB = await signIn(env, 'subject-b');
  await saveProfile({ env, request: request('/api/member/profile', { method: 'POST', cookie: cookieA, body: { ...sample, birthPlace: 'เชียงใหม่' } }) });
  await saveProfile({ env, request: request('/api/member/profile', { method: 'POST', cookie: cookieB, body: { ...sample, birthPlace: 'ภูเก็ต' } }) });
  const readA = await (await getProfile({ env, request: request('/api/member/profile', { cookie: cookieA }) })).json();
  const readB = await (await getProfile({ env, request: request('/api/member/profile', { cookie: cookieB }) })).json();
  assert.equal(readA.profile.birthPlace, 'เชียงใหม่');
  assert.equal(readB.profile.birthPlace, 'ภูเก็ต');
});

test('null, empty-string and false in numeric fields are rejected, not silently coerced to 0', async t => {
  const { env, db } = fixture(t);
  const cookie = await signIn(env, 'subject-a');
  for (const bad of [
    { ...sample, birthHour: null },
    { ...sample, birthMinute: '' },
    { ...sample, birthDay: false },
    { ...sample, birthMonth: '4' }, // numeric string is also not a JS number — must be rejected, not coerced
    { ...sample, birthYear: undefined }
  ]) {
    const response = await saveProfile({ env, request: request('/api/member/profile', { method: 'POST', cookie, body: bad }) });
    assert.equal(response.status, 400);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM birth_profiles').get().n, 0);
  // A real, valid 00:00 must still be accepted (this is the case the strict check must not break).
  const midnight = await (await saveProfile({ env, request: request('/api/member/profile', { method: 'POST', cookie, body: { ...sample, birthHour: 0, birthMinute: 0 } }) })).json();
  assert.equal(midnight.ok, true);
  assert.equal(midnight.profile.birthHour, 0);
  assert.equal(midnight.profile.birthMinute, 0);
});

test('a future birthdate is rejected server-side, compared against today in Asia/Bangkok', async t => {
  const { env, db } = fixture(t);
  const cookie = await signIn(env, 'subject-a');
  const nowBkk = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const future = { ...sample, birthYear: nowBkk.getUTCFullYear() + 1, birthMonth: nowBkk.getUTCMonth() + 1, birthDay: 1 };
  const response = await saveProfile({ env, request: request('/api/member/profile', { method: 'POST', cookie, body: future }) });
  assert.equal(response.status, 400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM birth_profiles').get().n, 0);
  // Today itself must still be accepted as a valid (edge-case) birthdate.
  const today = { ...sample, birthYear: nowBkk.getUTCFullYear(), birthMonth: nowBkk.getUTCMonth() + 1, birthDay: nowBkk.getUTCDate() };
  const saved = await (await saveProfile({ env, request: request('/api/member/profile', { method: 'POST', cookie, body: today }) })).json();
  assert.equal(saved.ok, true);
});
