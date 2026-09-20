// functions/lib/reading-json.mjs — read the 5-area reading out of Claude's text.
//
// The model is asked for bare JSON, but sometimes wraps it in a ```json fence
// or adds a short sentence before or after it. This finds the JSON object
// without being fooled by "{", "}" or quotes inside the reading's own text,
// and checks the fields the page needs. It never throws, never logs, and never
// returns any of the text it was given -- only the parsed reading or a reason.

export const READING_FIELDS = ['career', 'money', 'health', 'love', 'spirit'];

const MAX_CANDIDATES = 50;   // bounded work on a pathological answer

/**
 * @param {string} rawText
 * @returns {{ok:true, reading:object} |
 *           {ok:false, reason:'empty'|'no_json'|'truncated'|'invalid_json'|'missing_fields'}}
 */
export function parseReadingText(rawText) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) return { ok: false, reason: 'empty' };

  // Look inside a code fence first, then at the whole text.
  const sources = [];
  const fence = text.match(/```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/);
  if (fence) sources.push(fence[1]);
  sources.push(text);

  let sawObject = false, sawTruncated = false, sawMissing = false;
  for (const src of sources) {
    const r = scan(src);
    if (r.reading) return { ok: true, reading: r.reading };
    sawObject = sawObject || r.sawObject;
    sawTruncated = sawTruncated || r.truncated;
    sawMissing = sawMissing || r.missing;
  }

  if (sawMissing) return { ok: false, reason: 'missing_fields' };
  if (sawTruncated) return { ok: false, reason: 'truncated' };
  if (sawObject) return { ok: false, reason: 'invalid_json' };
  return { ok: false, reason: 'no_json' };
}

// Try every top-level "{ ... }" in order: find its matching "}" while
// skipping over JSON strings (so braces and escaped quotes inside the text
// do not count), then JSON.parse exactly that slice.
function scan(src) {
  const out = { reading: null, sawObject: false, truncated: false, missing: false };
  let tries = 0;
  let i = src.indexOf('{');
  while (i !== -1 && tries < MAX_CANDIDATES) {
    tries++;
    const end = matchingBrace(src, i);
    if (end === -1) {
      // Opened and never closed: the answer was cut off -- or this "{" was
      // just prose. Keep looking from the next "{" in case the JSON follows.
      out.truncated = true;
      i = src.indexOf('{', i + 1);
      continue;
    }
    out.sawObject = true;
    let value;
    try { value = JSON.parse(src.slice(i, end + 1)); } catch { value = undefined; }
    if (value !== undefined) {
      if (isReading(value)) {
        out.reading = normalise(value);
        return out;
      }
      if (value && typeof value === 'object' && !Array.isArray(value) &&
          READING_FIELDS.some((f) => f in value)) {
        out.missing = true;   // the right object, but a field is empty or wrong
      }
      i = src.indexOf('{', end + 1);   // skip this whole object
    } else {
      i = src.indexOf('{', i + 1);     // not valid JSON from here; try the next "{"
    }
  }
  return out;
}

function matchingBrace(s, start) {
  let depth = 0, inString = false, escaped = false;
  for (let k = start; k < s.length; k++) {
    const c = s[k];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return k; }
  }
  return -1;
}

function isReading(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    READING_FIELDS.every((f) => typeof v[f] === 'string' && v[f].trim() !== '');
}

// summary is optional, exactly as before: kept when it is an object, else null.
function normalise(v) {
  if (!v.summary || typeof v.summary !== 'object' || Array.isArray(v.summary)) v.summary = null;
  return v;
}
