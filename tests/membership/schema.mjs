import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migration = readFileSync(new URL('../../migrations/011_membership_core.sql', import.meta.url), 'utf8');
const legacySchema = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
const alice = 'member-alice-0001';
const bob = 'member-bob-000002';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(legacySchema);
  db.exec(migration);
  db.prepare('INSERT INTO users(id) VALUES (?), (?)').run(alice, bob);
  return db;
}

test('additive migration preserves paid rights and can be rerun', t => {
  const db = fixture(t);
  db.prepare("INSERT INTO payments(phone, status, token, expires_at) VALUES (?, 'paid', ?, ?)")
    .run('0900000000', 'test-only-existing-token', '2027-01-01 00:00:00');
  const before = db.prepare('SELECT * FROM payments').all();
  db.exec(migration);
  assert.deepEqual(db.prepare('SELECT * FROM payments').all(), before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 2);
});

test('one provider identity cannot belong to two accounts', t => {
  const db = fixture(t);
  const insert = db.prepare('INSERT INTO auth_identities(provider, provider_subject, user_id) VALUES (?, ?, ?)');
  insert.run('line', 'same-subject', alice);
  assert.throws(() => insert.run('line', 'same-subject', bob), /UNIQUE/);
  assert.equal(db.prepare('SELECT user_id FROM auth_identities').get().user_id, alice);
});

test('provider subjects are scoped; both providers can link to one account', t => {
  const db = fixture(t);
  const insert = db.prepare('INSERT INTO auth_identities(provider, provider_subject, user_id) VALUES (?, ?, ?)');
  insert.run('line', 'subject', alice);
  insert.run('google', 'subject', alice);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_identities WHERE user_id=?').get(alice).n, 2);
  assert.throws(() => insert.run('google', 'another-google-account', alice), /UNIQUE/);
});

test('unknown provider and orphan identity are rejected', t => {
  const db = fixture(t);
  const insert = db.prepare('INSERT INTO auth_identities(provider, provider_subject, user_id) VALUES (?, ?, ?)');
  assert.throws(() => insert.run('fake-provider', 'subject', alice), /CHECK/);
  assert.throws(() => insert.run('line', 'subject', 'nonexistent-user'), /FOREIGN KEY/);
  assert.throws(() => insert.run('line', '', alice), /CHECK/);
});

test('session constraints reject raw tokens, invalid lifetimes and orphan owners', t => {
  const db = fixture(t);
  const insert = db.prepare('INSERT INTO member_sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)');
  assert.throws(() => insert.run('raw-token', alice, 100, 200), /CHECK/);
  assert.throws(() => insert.run('z'.repeat(64), alice, 100, 200), /CHECK/);
  assert.throws(() => insert.run('a'.repeat(64), alice, 100, 100), /CHECK/);
  assert.throws(() => insert.run('a'.repeat(64), 'nonexistent-user', 100, 200), /FOREIGN KEY/);
  insert.run('a'.repeat(64), alice, 100, 200);
  assert.throws(() => insert.run('a'.repeat(64), bob, 100, 200), /UNIQUE/);
});

test('identity/session deletion is scoped to their owner, leaving payments intact', t => {
  const db = fixture(t);
  for (const [user, hash] of [[alice, 'a'], [bob, 'b']]) {
    db.prepare('INSERT INTO auth_identities(provider,provider_subject,user_id) VALUES (?,?,?)').run('line', user, user);
    db.prepare('INSERT INTO member_sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)')
      .run(hash.repeat(64), user, 100, 200);
  }
  db.prepare("INSERT INTO payments(phone,status) VALUES ('0900000000','paid')").run();
  db.prepare('DELETE FROM users WHERE id=?').run(alice);
  assert.equal(db.prepare('SELECT user_id FROM member_sessions').get().user_id, bob);
  assert.equal(db.prepare('SELECT user_id FROM auth_identities').get().user_id, bob);
  assert.equal(db.prepare('SELECT count(*) AS n FROM payments').get().n, 1);
});
