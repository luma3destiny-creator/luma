// Concurrency tests against a REAL SQLite database, with REAL parallel OS
// processes — not a mock that serialises the calls itself.
//
// Each case spawns N `conc/worker.mjs` processes that open the same database
// file and fire at the same moment. What is being tested is whether the SQL in
// functions/lib/otp.mjs holds its limits when the writers genuinely collide.
//
// Scope, stated plainly: this exercises SQLite's own write serialisation on one
// file. Cloudflare D1 is SQLite and documents that it serialises writes, but
// this run does not measure D1 itself. It also does not send any SMS: the mock
// provider is used throughout.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openD1 } from './d1.mjs';

const run = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname);
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
  for (const p of paidPhones) {
    raw.prepare(
      `INSERT INTO payments (phone, charge_id, amount, status, token, paid_at, expires_at)
       VALUES (?, ?, 5900, 'paid', ?, datetime('now'), datetime('now','+1 month'))`
    ).run(p, 'ch_' + p, 'old-token-' + p);
  }
  raw.close();
}


// Move every challenge's created_at back, so the 60s cooldown and the hourly
// counters behave as if that much time had passed. expires_at is deliberately
// NOT moved: the point of these cases is an OLD code that is still inside its
// 5-minute lifetime and must be refused anyway, because a newer one exists.
function ageChallenges(seconds) {
  const { raw } = openD1(DBFILE);
  try {
    raw.prepare(`UPDATE otp_challenges SET created_at = datetime(created_at, '-${seconds} seconds')`).run();
  } finally { raw.close(); }
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
  return results;
}

const TEST_ENV = { OTP_TEST_OUTBOX: 'true', OTP_TEST_PHONES: '' };

function codeFor(phone) {
  return read((raw) => {
    const r = raw.prepare(
      `SELECT code FROM otp_test_outbox WHERE phone = ? ORDER BY id DESC LIMIT 1`
    ).get(String(phone).replace(/\D/g, ''));
    return r ? r.code : null;
  });
}

console.log('\n--- real SQLite, real parallel processes, mock SMS -------------------\n');

// ── 1. the daily SMS cap holds under a burst ────────────────────────────────
{
  const phones = Array.from({ length: 10 }, (_, i) => '08000000' + String(10 + i));
  freshDb(phones);
  await burst(phones.map((p, i) => ['request', p, '10.0.0.' + i]), { CAP: '3' });

  const rows = read((raw) => raw.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN sms_reserved=1 THEN 1 ELSE 0 END) AS reserved,
            SUM(CASE WHEN send_status='sent' THEN 1 ELSE 0 END) AS sent
       FROM otp_challenges`).get());
  check('10 simultaneous requests, cap 3 → exactly 3 SMS slots reserved',
        Number(rows.reserved) === 3, 'reserved=' + rows.reserved);
  check('10 simultaneous requests, cap 3 → exactly 3 messages sent',
        Number(rows.sent) === 3, 'sent=' + rows.sent);
  check('a request row is written for every caller, not only the winners',
        Number(rows.total) === 10, 'rows=' + rows.total);
}

// ── 2. non-customers cannot drain the SMS budget ────────────────────────────
{
  const paid = ['0800000099'];
  freshDb(paid);
  const strangers = Array.from({ length: 8 }, (_, i) => '08999999' + String(10 + i));
  await burst(strangers.map((p, i) => ['request', p, '10.1.0.' + i]), { CAP: '3' });
  const after = read((raw) => raw.prepare(
    `SELECT COUNT(*) AS total, SUM(sms_reserved) AS reserved FROM otp_challenges`).get());
  check('8 requests for numbers that never paid reserve 0 SMS slots',
        Number(after.reserved || 0) === 0, 'reserved=' + after.reserved);
  check('…but each still leaves a throttle row, so the cooldown behaves the same',
        Number(after.total) === 8, 'rows=' + after.total);

  // the customer can still get a code afterwards: the budget was not touched
  await burst([['request', paid[0], '10.1.0.99']], { CAP: '3' });
  const cust = read((raw) => raw.prepare(
    `SELECT SUM(sms_reserved) AS reserved FROM otp_challenges`).get());
  check('a real customer can still be served after the stranger burst',
        Number(cust.reserved) === 1, 'reserved=' + cust.reserved);
}

// ── 3. one number, many simultaneous requests → one challenge ───────────────
{
  const phone = '0811111111';
  freshDb([phone]);
  await burst(Array.from({ length: 8 }, (_, i) => ['request', phone, '10.2.0.' + i]), { CAP: '20' });
  const n = read((raw) => raw.prepare(`SELECT COUNT(*) AS n FROM otp_challenges`).get()).n;
  check('8 simultaneous requests for one number → at most 1 challenge (cooldown)',
        Number(n) === 1, 'challenges=' + n);
}

// ── 4. a code can be redeemed exactly once ──────────────────────────────────
{
  const phone = '0822222222';
  freshDb([phone]);
  await burst([['request', phone, '10.3.0.1']], { CAP: '20', ...TEST_ENV, OTP_TEST_PHONES: '66822222222' });
  const code = codeFor('66822222222');
  const pub = read((raw) => raw.prepare(`SELECT public_id FROM otp_challenges LIMIT 1`).get()).public_id;
  check('the test outbox captured a code for the listed internal number', !!code);

  const res = await burst(Array.from({ length: 6 }, () => ['verify', phone, code, pub]), { CAP: '20' });
  const wins = res.filter(r => r.body && r.body.ok && r.body.token);
  const tokens = new Set(wins.map(r => r.body.token));
  check('6 simultaneous redemptions of one code → exactly 1 success',
        wins.length === 1, 'successes=' + wins.length);
  check('…and exactly 1 distinct token was issued', tokens.size === 1, 'tokens=' + tokens.size);
  const stored = read((raw) => raw.prepare(`SELECT token FROM payments WHERE phone=?`).get(phone)).token;
  check('the stored token is the one that was handed out',
        wins.length === 1 && stored === wins[0].body.token);
  check('the losers all got the same generic rejection',
        res.filter(r => r.status === 401).length === 5,
        '401s=' + res.filter(r => r.status === 401).length);
}

// ── 5. wrong guesses stop exactly at the attempt limit ──────────────────────
{
  const phone = '0833333333';
  freshDb([phone]);
  await burst([['request', phone, '10.4.0.1']], { CAP: '20', ...TEST_ENV, OTP_TEST_PHONES: '66833333333' });
  const realCode = codeFor('66833333333');
  const pub = read((raw) => raw.prepare(`SELECT public_id FROM otp_challenges LIMIT 1`).get()).public_id;

  const wrong = String((Number(realCode) + 1) % 1000000).padStart(6, '0');
  await burst(Array.from({ length: 20 }, () => ['verify', phone, wrong, pub]), { CAP: '20' });
  const att = read((raw) => raw.prepare(`SELECT attempts FROM otp_challenges LIMIT 1`).get()).attempts;
  check('20 simultaneous wrong guesses consume at most 5 attempts',
        Number(att) <= 5, 'attempts=' + att);

  const late = await burst([['verify', phone, realCode, pub]], { CAP: '20' });
  check('after the attempt budget is spent, even the real code is refused',
        late[0].status === 401, 'status=' + late[0].status);
  const tok = read((raw) => raw.prepare(`SELECT token FROM payments WHERE phone=?`).get(phone)).token;
  check('…and the customer token was never rotated', tok === 'old-token-' + phone);
}

// ── 6. a crash between "code accepted" and "token written" ──────────────────
{
  const phone = '0844444444';
  freshDb([phone]);
  await burst([['request', phone, '10.5.0.1']], { CAP: '20', ...TEST_ENV, OTP_TEST_PHONES: '66844444444' });
  const code = codeFor('66844444444');
  const pub = read((raw) => raw.prepare(`SELECT public_id FROM otp_challenges LIMIT 1`).get()).public_id;

  const crashed = await burst([['verify-crash', phone, code, pub]], { CAP: '20' });
  check('the interrupted run did accept the code', !!(crashed[0].crashedAfter && crashed[0].crashedAfter.ok));
  const mid = read((raw) => raw.prepare(`SELECT token FROM payments WHERE phone=?`).get(phone)).token;
  check('after the crash the payment row still holds the OLD token',
        mid === 'old-token-' + phone, 'token=' + mid);

  const retry = await burst([['verify', phone, code, pub]], { CAP: '20' });
  check('retrying the same code after a crash succeeds instead of burning it',
        retry[0].status === 200 && retry[0].body.ok, 'status=' + retry[0].status);
  check('…and returns the token the interrupted run had already reserved',
        retry[0].body && retry[0].body.token === 'tok-from-crashed-run',
        'token=' + (retry[0].body && retry[0].body.token));
  const end = read((raw) => raw.prepare(`SELECT token FROM payments WHERE phone=?`).get(phone)).token;
  check('…and the payment row now holds exactly that token',
        end === 'tok-from-crashed-run', 'token=' + end);

  const again = await burst([['verify', phone, code, pub]], { CAP: '20' });
  check('a third use of the same code is refused (recovery is not a reissue)',
        again[0].status === 401, 'status=' + again[0].status);
}

// ── 7. a customer's number and a stranger's number look identical ───────────
{
  const customer = '0855555555', stranger = '0866666666';
  freshDb([customer]);
  const first = await burst([['request', customer, '10.6.0.1'], ['request', stranger, '10.6.0.2']], { CAP: '20' });
  const [c1, s1] = first;
  check('same HTTP status for a customer and a stranger',
        c1.status === s1.status && c1.status === 200, c1.status + ' vs ' + s1.status);
  check('same response keys',
        JSON.stringify(Object.keys(c1.body).sort()) === JSON.stringify(Object.keys(s1.body).sort()),
        JSON.stringify(Object.keys(c1.body)) + ' vs ' + JSON.stringify(Object.keys(s1.body)));
  check('same message text', c1.body.message === s1.body.message);
  check('both got a challengeId of the same shape',
        /^[0-9a-f-]{36}$/.test(c1.body.challengeId) && /^[0-9a-f-]{36}$/.test(s1.body.challengeId));
  check('the two challengeIds differ', c1.body.challengeId !== s1.body.challengeId);

  // the cooldown is the tell that mattered: ask both again straight away
  const second = await burst([['request', customer, '10.6.0.1'], ['request', stranger, '10.6.0.2']], { CAP: '20' });
  const rows = read((raw) => raw.prepare(
    `SELECT phone_hash, COUNT(*) AS n FROM otp_challenges GROUP BY phone_hash`).all());
  check('a repeat within the cooldown creates no second row — for EITHER number',
        rows.length === 2 && rows.every(r => Number(r.n) === 1),
        JSON.stringify(rows.map(r => r.n)));
  check('and the repeat still answers 200 with the same shape, for both',
        second.every(r => r.status === 200 && r.body.message === c1.body.message));
}

// ── 8. the test outbox stays shut unless all three gates are open ───────────
{
  const phone = '0877777777';
  freshDb([phone]);
  await burst([['request', phone, '10.7.0.1']], { CAP: '20' });                       // no gates
  await burst([['request', '0877777778', '10.7.0.2']],
              { CAP: '20', OTP_TEST_OUTBOX: 'true', OTP_TEST_PHONES: '66877777777' }); // not listed
  const n = read((raw) => raw.prepare(`SELECT COUNT(*) AS n FROM otp_test_outbox`).get()).n;
  check('nothing reaches the test outbox without OTP_TEST_OUTBOX and a listed number',
        Number(n) === 0, 'rows=' + n);
}

// ── 9. no response, and no log line, ever carries the code ─────────────────
{
  const phone = '0888888888';
  freshDb([phone]);
  const out = await run(process.execPath,
    [path.join(HERE, 'worker-loud.mjs'), DBFILE, 'request', phone, '10.8.0.1'],
    { env: { ...process.env, CAP: '20', OTP_TEST_OUTBOX: 'true', OTP_TEST_PHONES: '66888888888' } });
  const code = codeFor('66888888888');
  check('a code was issued for this run', !!code);
  check('the code does not appear in the API response body',
        !out.stdout.includes(code), 'stdout');
  check('the code does not appear in anything the worker logged',
        !out.stderr.includes(code) && !out.stdout.includes(code));
}


// ── 10. a failed send must not let anyone in ───────────────────────────────
{
  const phone = '0899999991';
  freshDb([phone]);
  // brevo selected with no API key: refused before any request leaves.
  await burst([['request', phone, '10.9.0.1']], { CAP: '20', SMS_PROVIDER: 'brevo' });
  const row = read((raw) => raw.prepare(
    `SELECT public_id, send_status, send_error, sms_reserved FROM otp_challenges LIMIT 1`).get());
  check('a refused send is recorded as failed, not sent',
        row.send_status === 'failed', 'status=' + row.send_status);
  const tok = read((raw) => raw.prepare(`SELECT token FROM payments WHERE phone=?`).get(phone)).token;
  check('a refused send issues no entitlement', tok === 'old-token-' + phone);
  const guess = await burst([['verify', phone, '123456', row.public_id]], { CAP: '20' });
  check('…and no code can be guessed into working', guess[0].status === 401);
  check('…and no fallback ever accepts the phone number alone',
        read((raw) => raw.prepare(`SELECT token FROM payments WHERE phone=?`).get(phone)).token
          === 'old-token-' + phone);
}

// ── 11. no reply from the provider is 'unknown', not 'failed' ──────────────
{
  const phone = '0899999992';
  freshDb([phone]);
  await burst([['request', phone, '10.10.0.1']],
              { CAP: '20', SMS_PROVIDER: 'brevo', BREVO_API_KEY: 'k', SMS_SENDER_ID: 'LUMA',
                SIMULATE_TIMEOUT: 'true' });
  const row = read((raw) => raw.prepare(
    `SELECT send_status, sms_reserved FROM otp_challenges LIMIT 1`).get());
  check('a send with no reply is recorded as unknown — it may still be billed',
        row.send_status === 'unknown', 'status=' + row.send_status);
  check('…and it still counted against the SMS budget, because it may have been sent',
        Number(row.sms_reserved) === 1);
}

// ── 12. a challenge is bound to the number it was created for ──────────────
{
  const a = '0899999993', b = '0899999994';
  freshDb([a, b]);
  await burst([['request', a, '10.11.0.1']],
              { CAP: '20', ...TEST_ENV, OTP_TEST_PHONES: '66899999993' });
  const code = codeFor('66899999993');
  const pub = read((raw) => raw.prepare(`SELECT public_id FROM otp_challenges LIMIT 1`).get()).public_id;
  const cross = await burst([['verify', b, code, pub]], { CAP: '20' });
  check("another number cannot redeem this number's challenge",
        cross[0].status === 401, 'status=' + cross[0].status);
  check("…and that number's token was not touched",
        read((raw) => raw.prepare(`SELECT token FROM payments WHERE phone=?`).get(b)).token
          === 'old-token-' + b);
}

// ── 13. customers already holding a token are unaffected throughout ─────────
{
  const phone = '0899999995';
  freshDb([phone]);
  const before = await burst([['check-access', 'old-token-' + phone]]);
  check('an existing token holder is let in before any OTP activity',
        before[0].body && before[0].body.ok === true, JSON.stringify(before[0].body));

  await burst([['request', phone, '10.12.0.1']], { CAP: '20' });
  const after = await burst([['check-access', 'old-token-' + phone]]);
  check('…and still let in after a code has been requested',
        after[0].body && after[0].body.ok === true, JSON.stringify(after[0].body));

  const stranger = await burst([['check-access', 'not-a-real-token']]);
  check('a token nobody was issued is refused',
        !(stranger[0].body && stranger[0].body.ok), JSON.stringify(stranger[0].body));
}


// ── 14. asking for a new code retires the old one ──────────────────────────
// The bug this closes: request A, wait out the cooldown, request B -- and A's
// code still opened the account. Two live codes for one number is one code too
// many.
{
  const phone = '0866000001';
  freshDb([phone]);
  const E164 = '66866000001';
  await burst([['request', phone, '10.14.0.1']], { CAP: '20', ...TEST_ENV, OTP_TEST_PHONES: E164 });
  const codeA = codeFor(E164);
  const pubA = read((raw) => raw.prepare(`SELECT public_id FROM otp_challenges ORDER BY id DESC LIMIT 1`).get()).public_id;

  ageChallenges(70);   // past the cooldown
  await burst([['request', phone, '10.14.0.1']], { CAP: '20', ...TEST_ENV, OTP_TEST_PHONES: E164 });
  const codeB = codeFor(E164);
  const pubB = read((raw) => raw.prepare(`SELECT public_id FROM otp_challenges ORDER BY id DESC LIMIT 1`).get()).public_id;
  check('the resend produced a different code and challenge',
        codeA !== codeB && pubA !== pubB);

  const oldTry = await burst([['verify', phone, codeA, pubA]], { CAP: '20' });
  check('the OLD code is refused once a new one has been sent',
        oldTry[0].status === 401, 'status=' + oldTry[0].status);
  check('…and the old attempt rotated nothing',
        read((raw) => raw.prepare(`SELECT token FROM payments WHERE phone=?`).get(phone)).token
          === 'old-token-' + phone);
  check('…and it did not even spend an attempt on the retired challenge',
        Number(read((raw) => raw.prepare(`SELECT attempts FROM otp_challenges WHERE public_id=?`).get(pubA)).attempts) === 0);

  const newTry = await burst([['verify', phone, codeB, pubB]], { CAP: '20' });
  check('the NEW code still works', newTry[0].status === 200 && newTry[0].body.ok);
}

// ── 15. a resend the provider REFUSED must not retire the working code ─────
{
  const phone = '0866000002';
  freshDb([phone]);
  const E164 = '66866000002';
  await burst([['request', phone, '10.15.0.1']], { CAP: '20', ...TEST_ENV, OTP_TEST_PHONES: E164 });
  const codeA = codeFor(E164);
  const pubA = read((raw) => raw.prepare(`SELECT public_id FROM otp_challenges ORDER BY id DESC LIMIT 1`).get()).public_id;

  ageChallenges(70);
  // brevo with no API key: refused before anything leaves. Nothing was delivered,
  // so the customer is still holding codeA and must not be stranded.
  await burst([['request', phone, '10.15.0.1']], { CAP: '20', SMS_PROVIDER: 'brevo' });
  check('the failed resend is recorded as failed',
        read((raw) => raw.prepare(`SELECT send_status FROM otp_challenges ORDER BY id DESC LIMIT 1`).get()).send_status === 'failed');

  const stillWorks = await burst([['verify', phone, codeA, pubA]], { CAP: '20' });
  check('a resend that never went out does NOT retire the code in hand',
        stillWorks[0].status === 200 && stillWorks[0].body.ok, 'status=' + stillWorks[0].status);
}

// ── 16. a resend with no reply DOES retire the old code ───────────────────
// 'unknown' means it may well have been delivered. Leaving the old one alive on
// that guess is the same two-live-codes bug, so the safe reading wins.
{
  const phone = '0866000003';
  freshDb([phone]);
  const E164 = '66866000003';
  await burst([['request', phone, '10.16.0.1']], { CAP: '20', ...TEST_ENV, OTP_TEST_PHONES: E164 });
  const codeA = codeFor(E164);
  const pubA = read((raw) => raw.prepare(`SELECT public_id FROM otp_challenges ORDER BY id DESC LIMIT 1`).get()).public_id;

  ageChallenges(70);
  await burst([['request', phone, '10.16.0.1']],
              { CAP: '20', SMS_PROVIDER: 'brevo', BREVO_API_KEY: 'k', SMS_SENDER_ID: 'LUMA', SIMULATE_TIMEOUT: 'true' });
  check('the no-reply resend is recorded as unknown',
        read((raw) => raw.prepare(`SELECT send_status FROM otp_challenges ORDER BY id DESC LIMIT 1`).get()).send_status === 'unknown');

  const oldTry = await burst([['verify', phone, codeA, pubA]], { CAP: '20' });
  check('a resend that may have gone out DOES retire the old code',
        oldTry[0].status === 401, 'status=' + oldTry[0].status);
}

// ── 17. retiring survives simultaneous attempts ───────────────────────────
{
  const phone = '0866000004';
  freshDb([phone]);
  const E164 = '66866000004';
  await burst([['request', phone, '10.17.0.1']], { CAP: '20', ...TEST_ENV, OTP_TEST_PHONES: E164 });
  const codeA = codeFor(E164);
  const pubA = read((raw) => raw.prepare(`SELECT public_id FROM otp_challenges ORDER BY id DESC LIMIT 1`).get()).public_id;
  ageChallenges(70);
  await burst([['request', phone, '10.17.0.1']], { CAP: '20', ...TEST_ENV, OTP_TEST_PHONES: E164 });
  const codeB = codeFor(E164);
  const pubB = read((raw) => raw.prepare(`SELECT public_id FROM otp_challenges ORDER BY id DESC LIMIT 1`).get()).public_id;

  const olds = await burst(Array.from({ length: 6 }, () => ['verify', phone, codeA, pubA]), { CAP: '20' });
  check('6 simultaneous attempts with the retired code all fail',
        olds.every(r => r.status === 401), JSON.stringify(olds.map(r => r.status)));

  const news = await burst(Array.from({ length: 6 }, () => ['verify', phone, codeB, pubB]), { CAP: '20' });
  const wins = news.filter(r => r.body && r.body.ok && r.body.token);
  check('6 simultaneous attempts with the live code → exactly 1 success', wins.length === 1,
        'successes=' + wins.length);
  check('…and the payment row holds that one token',
        read((raw) => raw.prepare(`SELECT token FROM payments WHERE phone=?`).get(phone)).token
          === wins[0].body.token);
}

// ── 18. an interrupted issue still completes when nothing newer exists ─────
{
  const phone = '0866000005';
  freshDb([phone]);
  const E164 = '66866000005';
  await burst([['request', phone, '10.18.0.1']], { CAP: '20', ...TEST_ENV, OTP_TEST_PHONES: E164 });
  const code = codeFor(E164);
  const pub = read((raw) => raw.prepare(`SELECT public_id FROM otp_challenges ORDER BY id DESC LIMIT 1`).get()).public_id;

  await burst([['verify-crash', phone, code, pub]], { CAP: '20' });
  const retry = await burst([['verify', phone, code, pub]], { CAP: '20' });
  check('crash recovery still works when no newer code was sent',
        retry[0].status === 200 && retry[0].body.token === 'tok-from-crashed-run',
        'status=' + retry[0].status);
}

// ── 19. an interrupted issue cannot overwrite a newer token ───────────────
// The dangerous shape: the customer gives up on the interrupted code, asks for
// a new one, succeeds -- and then the stale reserved token gets applied on top,
// silently logging them out.
{
  const phone = '0866000006';
  freshDb([phone]);
  const E164 = '66866000006';
  await burst([['request', phone, '10.19.0.1']], { CAP: '20', ...TEST_ENV, OTP_TEST_PHONES: E164 });
  const codeA = codeFor(E164);
  const pubA = read((raw) => raw.prepare(`SELECT public_id FROM otp_challenges ORDER BY id DESC LIMIT 1`).get()).public_id;
  await burst([['verify-crash', phone, codeA, pubA]], { CAP: '20' });

  ageChallenges(70);
  await burst([['request', phone, '10.19.0.1']], { CAP: '20', ...TEST_ENV, OTP_TEST_PHONES: E164 });
  const codeB = codeFor(E164);
  const pubB = read((raw) => raw.prepare(`SELECT public_id FROM otp_challenges ORDER BY id DESC LIMIT 1`).get()).public_id;
  const good = await burst([['verify', phone, codeB, pubB]], { CAP: '20' });
  check('the new code issues a token normally', good[0].status === 200 && good[0].body.ok);
  const current = read((raw) => raw.prepare(`SELECT token FROM payments WHERE phone=?`).get(phone)).token;

  const stale = await burst([['verify', phone, codeA, pubA]], { CAP: '20' });
  check('the interrupted older code is refused afterwards',
        stale[0].status === 401, 'status=' + stale[0].status);
  check('…and the newer token was NOT overwritten',
        read((raw) => raw.prepare(`SELECT token FROM payments WHERE phone=?`).get(phone)).token === current);
  check('…and no second token was handed out', !(stale[0].body && stale[0].body.token));
}

// ── 20. expiry is unchanged by any of this ────────────────────────────────
{
  const phone = '0866000007';
  freshDb([phone]);
  const before = read((raw) => raw.prepare(`SELECT expires_at FROM payments WHERE phone=?`).get(phone)).expires_at;
  const E164 = '66866000007';
  await burst([['request', phone, '10.20.0.1']], { CAP: '20', ...TEST_ENV, OTP_TEST_PHONES: E164 });
  const code = codeFor(E164);
  const pub = read((raw) => raw.prepare(`SELECT public_id FROM otp_challenges ORDER BY id DESC LIMIT 1`).get()).public_id;
  await burst([['verify', phone, code, pub]], { CAP: '20' });
  check('recovering access never moves the entitlement expiry date',
        read((raw) => raw.prepare(`SELECT expires_at FROM payments WHERE phone=?`).get(phone)).expires_at === before);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed   (real SQLite file, ' +
            'parallel OS processes, SMS provider: mock — 0 messages sent)\n');
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DBFILE + suffix); } catch {} }
process.exit(fail ? 1 : 0);
