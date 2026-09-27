// Stripe webhook concurrency/idempotency tests against a REAL SQLite
// database, with REAL parallel OS processes.
//
// Split out of test_concurrency_sqlite.mjs: this suite is about
// /api/stripe-webhook's own retry/idempotency safety and has nothing to do
// with phone/OTP recovery (retired this round — see request-otp.js,
// verify-otp.js and check-access.js's phone branch). Keeping it in its own
// file means it keeps running and staying green independently of anything
// that happens to the (now retired) OTP concurrency scenarios.
//
// The bug this whole file guards against: the event used to be recorded on
// ARRIVAL and the work done afterwards. When the work failed, the first
// delivery answered 500, Stripe retried, and the retry found the row already
// there and answered "duplicate ignored" — while the payment sat pending
// with no token. A paid customer, silently given nothing, with the books
// saying the event was handled.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openD1 } from './d1.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Deliberately NOT inside the repo: SQLite's WAL mode needs real shared memory,
// which a network or fuse-mounted folder does not reliably provide, and the run
// should not leave files in the working tree either.
const DBFILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'luma-webhook-')), 'conc-test.sqlite');

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
  raw.exec(fs.readFileSync(path.join(HERE, '..', '..', 'migrations', '004_webhook_events.sql'), 'utf8'));
  raw.exec(fs.readFileSync(path.join(HERE, '..', '..', 'migrations', '007_webhook_unresolved.sql'), 'utf8'));
  // stripe-webhook.js/entitlement.mjs do not touch owner_user_id themselves,
  // but pay.js's real INSERT includes the column, and check-access.js/
  // paid-access.mjs now unconditionally select it -- keep the fixture schema
  // aligned with production so a future test added here does not silently
  // hit "no such column".
  raw.exec(fs.readFileSync(path.join(HERE, '..', '..', 'migrations', '015_payments_owner.sql'), 'utf8'));
  for (const p of paidPhones) {
    raw.prepare(
      `INSERT INTO payments (phone, charge_id, amount, status, token, paid_at, expires_at)
       VALUES (?, ?, 5900, 'paid', ?, datetime('now'), datetime('now','+1 month'))`
    ).run(p, 'ch_' + p, 'old-token-' + p);
  }
  raw.close();
}

// A PENDING order, the state /api/pay leaves behind before the customer has
// paid. Fixture data in a throwaway temp database — nothing here is ever run
// against Preview or Production, and no row is ever hand-marked paid: the
// webhook under test is what does that.
function seedPendingOrder(chargeId, phone = '0900000000', amount = 5900) {
  const { raw } = openD1(DBFILE);
  try {
    raw.prepare(
      `INSERT INTO payments (phone, charge_id, amount, status, created_at)
       VALUES (?, ?, ?, 'pending', datetime('now'))`
    ).run(phone, chargeId, amount);
  } finally { raw.close(); }
}

function orderRow(chargeId) {
  return read((raw) => raw.prepare(
    `SELECT status, token, paid_at, expires_at FROM payments WHERE charge_id = ?`
  ).get(chargeId));
}

function unresolvedRows() {
  return read((raw) => raw.prepare(
    `SELECT event_id, reason, attempts, payload, resolved_at FROM webhook_unresolved`).all());
}

function eventRows() {
  return read((raw) => raw.prepare(`SELECT event_id FROM webhook_events`).all());
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

console.log('\n--- Stripe webhook retry/idempotency, real SQLite, real parallel processes -------------------\n');

// ── 1. a failure before granting must leave the event retryable ───────────
{
  freshDb([]);
  const CH = 'pi_wh_retry';
  seedPendingOrder(CH);

  const first = await burst([['webhook', CH, 'evt_retry_1']], { FAIL_AT: 'grant' });
  check('a database failure while granting answers 500 so Stripe retries',
        first[0].status === 500, 'status=' + first[0].status);
  check('…the order is still pending', orderRow(CH).status === 'pending');
  check('…and NOTHING was recorded, so the event is not marked handled',
        eventRows().length === 0, 'events=' + eventRows().length);

  const retry = await burst([['webhook', CH, 'evt_retry_1']]);
  check('the retry of the same event actually grants (not "duplicate ignored")',
        retry[0].status === 200 && retry[0].body === 'ok',
        'status=' + retry[0].status + ' body=' + retry[0].body);
  const row = orderRow(CH);
  check('…the order is now paid', row.status === 'paid');
  check('…and it has a token', !!row.token);
  check('…and the event is recorded only now', eventRows().length === 1);
}

// ── 2. a failure AFTER granting, before recording, still completes ────────
{
  freshDb([]);
  const CH = 'pi_wh_after';
  seedPendingOrder(CH);

  const first = await burst([['webhook', CH, 'evt_after_1']], { FAIL_AT: 'record_event' });
  check('dying after the grant answers 500', first[0].status === 500, 'status=' + first[0].status);
  const mid = orderRow(CH);
  check('…the entitlement was granted anyway', mid.status === 'paid' && !!mid.token);
  check('…but the event is not recorded', eventRows().length === 0);

  const retry = await burst([['webhook', CH, 'evt_after_1']]);
  check('the retry completes without granting a second time',
        retry[0].status === 200, 'status=' + retry[0].status);
  const after = orderRow(CH);
  check('…the token is unchanged', after.token === mid.token);
  check('…the paid_at is unchanged', after.paid_at === mid.paid_at);
  check('…and the expiry date was not moved', after.expires_at === mid.expires_at);
  check('…and the event is recorded once', eventRows().length === 1);
}

// ── 3. simultaneous deliveries grant exactly once ────────────────────────
{
  freshDb([]);
  const CH = 'pi_wh_race';
  seedPendingOrder(CH);

  const all = await burst(Array.from({ length: 6 }, () => ['webhook', CH, 'evt_race_1']));
  check('6 simultaneous deliveries of one event all answer 200',
        all.every(r => r.status === 200), JSON.stringify(all.map(r => r.status)));
  const row = orderRow(CH);
  check('…the order is paid exactly once, with one token', row.status === 'paid' && !!row.token);
  check('…and only one event row exists', eventRows().length === 1);
  check('…and no response leaked a token',
        all.every(r => !String(r.body).includes(row.token)));
}

// ── 4. a replay after success is cheap and changes nothing ───────────────
{
  freshDb([]);
  const CH = 'pi_wh_replay';
  seedPendingOrder(CH);
  await burst([['webhook', CH, 'evt_replay_1']]);
  const before = orderRow(CH);

  const again = await burst([['webhook', CH, 'evt_replay_1']]);
  check('replaying a finished event answers duplicate ignored',
        again[0].status === 200 && again[0].body === 'duplicate ignored',
        'body=' + again[0].body);
  const after = orderRow(CH);
  check('…and the token, paid_at and expiry are all untouched',
        after.token === before.token && after.paid_at === before.paid_at &&
        after.expires_at === before.expires_at);
}

// ── 5. an event that arrives before its order is not thrown away ─────────
{
  freshDb([]);
  const CH = 'pi_wh_early';

  const early = await burst([['webhook', CH, 'evt_early_1']]);
  check('an event with no order yet answers 500 so Stripe delivers it again',
        early[0].status === 500, 'status=' + early[0].status);
  check('…and it is NOT marked handled', eventRows().length === 0);

  // …then /api/pay writes the order, and the retry lands.
  seedPendingOrder(CH);
  const late = await burst([['webhook', CH, 'evt_early_1']]);
  check('once the order exists the retry grants normally',
        late[0].status === 200 && late[0].body === 'ok', 'status=' + late[0].status);
  check('…the order is paid', orderRow(CH).status === 'paid');
}

// ── 6. an orphan event is parked, never closed out on a guess ────────────
// The earlier version decided, from the event's age alone, that the order was
// never coming and recorded it as processed. Nothing in this code can know
// that, and being wrong means the event is dead forever.
{
  freshDb([]);
  const CH = 'pi_wh_orphan';
  const a = await burst([['webhook', CH, 'evt_orphan_1', '5900', '7200']]);
  check('an old orphan is still refused, not closed out on its age',
        a[0].status === 500, 'status=' + a[0].status);
  check('…it is NEVER recorded as processed', eventRows().length === 0);
  let open = unresolvedRows();
  check('…it is parked as unresolved instead', open.length === 1 && open[0].reason === 'no_order');
  check('…with the payload kept so it can be replayed',
        !!open[0].payload && String(open[0].payload).includes('evt_orphan_1'));

  await burst([['webhook', CH, 'evt_orphan_1', '5900', '7200']]);
  open = unresolvedRows();
  check('…and a further delivery counts an attempt rather than duplicating the row',
        open.length === 1 && Number(open[0].attempts) === 2, 'attempts=' + open[0].attempts);
  check('…still open', !open[0].resolved_at);

  // the order finally appears — the parked event must now be able to complete
  seedPendingOrder(CH);
  const done = await burst([['webhook', CH, 'evt_orphan_1', '5900', '7200']]);
  check('once the order exists, the parked event completes for real',
        done[0].status === 200 && done[0].body === 'ok', 'status=' + done[0].status);
  check('…the order is paid', orderRow(CH).status === 'paid');
  check('…and the unresolved row is closed', !!unresolvedRows()[0].resolved_at);
}

// ── 7. a wrong amount never entitles, and never retries ──────────────────
{
  freshDb([]);
  const CH = 'pi_wh_amount';
  seedPendingOrder(CH);
  const res = await burst([['webhook', CH, 'evt_amount_1', '100']]);
  check('a mismatched amount answers 200 (retrying cannot fix it)',
        res[0].status === 200 && String(res[0].body).indexOf('not entitled') === 0,
        'body=' + res[0].body);
  check('…and grants nothing', orderRow(CH).status === 'pending' && !orderRow(CH).token);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed   (real SQLite file, ' +
            'parallel OS processes, Stripe webhook signature verified — no card ever charged)\n');
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DBFILE + suffix); } catch {} }
process.exit(fail ? 1 : 0);
