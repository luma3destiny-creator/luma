// Concurrency tests against a REAL SQLite database, with REAL parallel OS
// processes — not a mock that serialises the calls itself.
//
// This file used to also exercise phone/OTP recovery's own crash-safety and
// throttling logic under concurrency, through the real request-otp.js/
// verify-otp.js/check-access.js?phone= handlers. That feature has been
// permanently retired (see functions/api/request-otp.js, verify-otp.js, and
// the phone branch of check-access.js — all unconditional 410s now, with no
// prior-purchase data behind this rollout that still needed it). What is
// left to prove under real concurrency is:
//
//   1. the retirement itself holds under a burst of simultaneous callers —
//      every request/verify call answers 410, and NOTHING is ever written
//      to otp_challenges or otp_test_outbox, however many arrive at once or
//      whatever legacy env flags are set;
//   2. the check-access token branch — unaffected by the phone-path
//      retirement, but now REQUIRING a live session that matches the row's
//      owner (see functions/lib/paid-access.mjs's header) — is consistently
//      right under a burst: the real owner is let in every time, and an
//      unauthenticated burst against the same token is refused every time.
//
// The Stripe webhook idempotency/retry-safety concurrency tests that used to
// live in this same file are unrelated to any of this and have moved to
// tests/otp-concurrency/test_webhook_concurrency.mjs so they keep running on
// their own, unaffected by this retirement.
//
// Scope, stated plainly: this exercises SQLite's own write serialisation on
// one file. Cloudflare D1 is SQLite and documents that it serialises writes,
// but this run does not measure D1 itself. It also never sends any SMS.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openD1 } from './d1.mjs';
import { randomToken, hash as sha256Hash, nowSeconds, SESSION_COOKIE } from '../../functions/lib/member-session.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Deliberately NOT inside the repo: SQLite's WAL mode needs real shared memory,
// which a network or fuse-mounted folder does not reliably provide, and the run
// should not leave files in the working tree either.
const DBFILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'luma-otp-')), 'conc-test.sqlite');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  → ' + detail : '')); }
}

function freshDb(paidPhones) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DBFILE + suffix); } catch {}
  }
  const { raw } = openD1(DBFILE);
  raw.exec(fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8'));
  raw.exec(fs.readFileSync(path.join(HERE, '..', '..', 'migrations', '005_otp_challenges.sql'), 'utf8'));
  raw.exec(fs.readFileSync(path.join(HERE, '..', '..', 'migrations', '006_preview_test_outbox.sql'), 'utf8'));
  // check-access.js/paid-access.mjs unconditionally SELECT payments.owner_user_id
  // on every request, and now REQUIRE it set (no more unowned/anonymous access
  // — see functions/lib/paid-access.mjs's header) — without this migration
  // that query fails outright (column does not exist).
  raw.exec(fs.readFileSync(path.join(HERE, '..', '..', 'migrations', '015_payments_owner.sql'), 'utf8'));
  raw.exec(fs.readFileSync(path.join(HERE, '..', '..', 'migrations', '016_otp_challenges_purpose.sql'), 'utf8'));
  raw.exec(fs.readFileSync(path.join(HERE, '..', '..', 'migrations', '011_membership_core.sql'), 'utf8'));
  for (const p of paidPhones) {
    raw.prepare(
      `INSERT INTO payments (phone, charge_id, amount, status, token, paid_at, expires_at)
       VALUES (?, ?, 5900, 'paid', ?, datetime('now'), datetime('now','+1 month'))`
    ).run(p, 'ch_' + p, 'old-token-' + p);
  }
  raw.close();
}

function read(fn) {
  const { raw, DB } = openD1(DBFILE);
  try { return fn(raw, DB); } finally { raw.close(); }
}

// Fire N workers at once and collect their stdout.
async function burst(specs, env = {}) {
  const results = await Promise.all(specs.map(args =>
    run(process.execPath, [path.join(HERE, 'worker.mjs'), DBFILE, ...args],
        { env: { ...process.env, ...env } })
      .then(r => { try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout }; } })
      .catch(e => { try { return JSON.parse(e.stdout); }
                    catch { return { error: String(e.message), stderr: String(e.stderr || '').slice(0, 400) }; } })
  ));
  for (const result of results) {
    if (result.error || result.raw !== undefined) {
      throw new Error('Concurrency worker failed: ' + JSON.stringify(result));
    }
  }
  return results;
}

function challengeCount() {
  return read((raw) => raw.prepare(`SELECT COUNT(*) AS n FROM otp_challenges`).get()).n;
}
function outboxCount() {
  return read((raw) => raw.prepare(`SELECT COUNT(*) AS n FROM otp_test_outbox`).get()).n;
}

console.log('\n--- real SQLite, real parallel processes, mock SMS -------------------\n');

// ── 1. request-otp.js stays a hard 410 under a burst, whatever the env ─────
{
  const phones = Array.from({ length: 10 }, (_, i) => '08000000' + String(10 + i));
  freshDb(phones);
  const legacyEnvs = [
    {},
    { OTP_TEST_OUTBOX: 'true', OTP_TEST_PHONES: '' },
    { PURCHASE_RECOVERY_DISABLED: 'false' },
    { OTP_RECOVERY_ENABLED: 'true' }
  ];
  for (const extraEnv of legacyEnvs) {
    const results = await burst(phones.map((p, i) => ['request', p, '10.0.0.' + i]), extraEnv);
    check('10 simultaneous request-otp calls all answer 410 (env=' + JSON.stringify(extraEnv) + ')',
          results.every(r => r.status === 410 && r.body && r.body.code === 'RECOVERY_RETIRED'),
          JSON.stringify(results.map(r => r.status)));
  }
  check('after every burst above, otp_challenges is still empty', Number(challengeCount()) === 0, 'rows=' + challengeCount());
  check('…and otp_test_outbox is still empty (no SMS was ever queued)', Number(outboxCount()) === 0, 'rows=' + outboxCount());
}

// ── 2. verify-otp.js stays a hard 410 under a burst, and rotates nothing ───
{
  const phone = '0811111111';
  freshDb([phone]);
  const results = await burst(
    Array.from({ length: 10 }, () => ['verify', phone, '123456', 'not-a-real-challenge-id']),
    {}
  );
  check('10 simultaneous verify-otp calls all answer 410',
        results.every(r => r.status === 410 && r.body && r.body.code === 'RECOVERY_RETIRED'),
        JSON.stringify(results.map(r => r.status)));
  check('the pre-existing payment token was never touched by any of them',
        read((raw) => raw.prepare(`SELECT token FROM payments WHERE phone=?`).get(phone)).token === 'old-token-' + phone);
  check('otp_challenges is still empty', Number(challengeCount()) === 0, 'rows=' + challengeCount());
}

// ── 3. check-access token branch: the real owner is let in, consistently,
//      under a concurrent burst; an unauthenticated burst against the exact
//      same token is refused every single time ───────────────────────────
{
  const phone = '0822222222';
  const owner = 'member-conc-alice-01';
  freshDb([phone]);
  const token = 'old-token-' + phone;
  const now = nowSeconds();
  await (async () => {
    const { raw } = openD1(DBFILE);
    try {
      raw.prepare(`UPDATE payments SET owner_user_id = ? WHERE token = ?`).run(owner, token);
      raw.prepare(`INSERT INTO users(id) VALUES (?)`).run(owner);
      const sessionToken = randomToken();
      raw.prepare(`INSERT INTO member_sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
        .run(await sha256Hash(sessionToken), owner, now, now + 3600);
      globalThis.__concSessionCookie = `${SESSION_COOKIE}=${sessionToken}`;
    } finally { raw.close(); }
  })();
  const cookie = globalThis.__concSessionCookie;

  const authed = await burst(Array.from({ length: 8 }, () => ['check-access', token, cookie]));
  check('8 simultaneous check-access calls, signed in as the real owner, all report ok',
        authed.every(r => r.body && r.body.ok === true), JSON.stringify(authed.map(r => r.body)));

  const unauthed = await burst(Array.from({ length: 8 }, () => ['check-access', token, '']));
  check('8 simultaneous check-access calls with NO session all report refused — no race lets one through',
        unauthed.every(r => !(r.body && r.body.ok === true)), JSON.stringify(unauthed.map(r => r.body)));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed   (real SQLite file, ' +
            'parallel OS processes, SMS provider: mock — 0 messages sent)\n');
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DBFILE + suffix); } catch {} }
process.exit(fail ? 1 : 0);
