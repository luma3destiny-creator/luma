// A D1-shaped facade over a REAL SQLite file (node:sqlite).
//
// This is not a simulation of D1's concurrency: the point of these tests is
// that the SQL itself is atomic when several OS processes write to one real
// SQLite database at the same time. What it does NOT prove is anything about
// Cloudflare's own scheduling — that D1 serialises writers is a documented
// property we rely on, not something measured here.
import { DatabaseSync } from 'node:sqlite';

export function openD1(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 15000');
  db.exec('PRAGMA synchronous = FULL');

  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    first() {
      const st = db.prepare(sql);
      const row = st.get(...(args || []));
      return row === undefined ? null : row;
    },
    all() { return { results: db.prepare(sql).all(...(args || [])) }; },
    run() {
      const r = db.prepare(sql).run(...(args || []));
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
  });
  return { raw: db, DB: { prepare: (sql) => mk(sql, []) } };
}
