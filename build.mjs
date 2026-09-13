#!/usr/bin/env node
// build.mjs — packages the PUBLIC website into ./dist for Cloudflare Pages.
//
// Why an allowlist and not an ignore-list:
//   Everything not named here simply never reaches dist/, so nothing internal
//   can leak by being forgotten. `.assetsignore` is the opposite (deny-list)
//   and its behaviour on the Git-build path is unverified — this file removes
//   the need to rely on it at all.
//
// What this does NOT handle, on purpose:
//   Pages Functions. Cloudflare reads them from `<project root>/functions`,
//   NOT from the build output directory — the docs say the functions dir must
//   be "at the root of your Pages project (and not in the static root, such
//   as /dist)". So `functions/` must stay where it is and must NOT be copied
//   into dist/. Verified locally with `wrangler pages functions build`:
//   only functions/api/*.js become routes; functions/lib/age.mjs is bundled
//   as an imported module and is not routed and not served.
//
// The build FAILS (non-zero exit) if an allowlisted file is missing or if a
// forbidden file somehow ends up in dist/ — a failed build publishes nothing,
// which is the safe outcome.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, 'dist');

// ── the allowlist: every file that is allowed to be public ──────────────────
// Each entry is "source path relative to repo root". It is copied to the same
// relative path inside dist/.
const ALLOW = [
  'index.html',              // landing page
  'app.html',                // the app itself (served at /app and /app.html)
  'privacy.html',            // linked from index.html and app.html
  'Logo/luma_icon_gold.png', // the only image any published page references
];

// ── anything matching these must never appear in dist/ (belt-and-braces) ────
const FORBIDDEN = [
  { label: 'SQL files', test: (p) => /\.sql$/i.test(p) },
  { label: 'test files', test: (p) => /(^|\/)test[-_.]/i.test(p) },
  { label: 'migration files', test: (p) => /(^|\/)migrations?(\/|$)/i.test(p) },
  { label: 'the legacy index.source.html', test: (p) => /index\.source\.html$/i.test(p) },
  { label: 'Netlify files', test: (p) => /(^|\/)netlify/i.test(p) || /netlify\.toml$/i.test(p) },
  { label: 'notes/docs (.txt/.md)', test: (p) => /\.(txt|md)$/i.test(p) },
  { label: 'dotfiles', test: (p) => p.split('/').some((seg) => seg.startsWith('.')) },
  { label: 'Pages Functions (must stay at project root, never in dist)', test: (p) => /(^|\/)functions(\/|$)/i.test(p) },
  { label: 'scratch/output folders', test: (p) => /(^|\/)(outputs|Claude outputs|_to_delete|Post)(\/|$)/i.test(p) },
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// ── 1. clean ────────────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ── 2. copy the allowlist (fail loudly on anything missing) ─────────────────
const missing = ALLOW.filter((rel) => !existsSync(join(ROOT, rel)));
if (missing.length) {
  console.error('BUILD FAILED — these allowlisted files do not exist:');
  for (const m of missing) console.error('  ' + m);
  process.exit(1);
}

for (const rel of ALLOW) {
  const dest = join(OUT, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(join(ROOT, rel)));
}

// ── 3. verify what actually landed in dist/ ─────────────────────────────────
const produced = walk(OUT).map((f) => relative(OUT, f).split(sep).join('/')).sort();
const expected = [...ALLOW].sort();

const unexpected = produced.filter((p) => !expected.includes(p));
if (unexpected.length) {
  console.error('BUILD FAILED — unexpected files in dist/:');
  for (const u of unexpected) console.error('  ' + u);
  process.exit(1);
}

const violations = [];
for (const p of produced) {
  for (const rule of FORBIDDEN) {
    if (rule.test(p)) violations.push(`${p}  (${rule.label})`);
  }
}
if (violations.length) {
  console.error('BUILD FAILED — forbidden files present in dist/:');
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}

// ── 4. report ───────────────────────────────────────────────────────────────
let total = 0;
console.log('dist/ contents (' + produced.length + ' files):');
for (const p of produced) {
  const bytes = statSync(join(OUT, p)).size;
  total += bytes;
  console.log('  ' + String(bytes).padStart(8) + '  ' + p);
}
console.log('total: ' + total + ' bytes');
console.log('');
console.log('Pages Functions are NOT in dist/ by design — Cloudflare reads them');
console.log('from <project root>/functions. Nothing else from the repo is published.');
console.log('BUILD OK');
