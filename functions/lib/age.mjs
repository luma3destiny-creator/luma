// functions/lib/age.mjs — shared age-at-purchase computation
//
// LUMA stopped storing customer birthdates permanently (see schema.sql).
// Instead every payment row stores `age_at_purchase`: the customer's full
// age in years, as of the reference date for that transaction, computed
// once and never re-derivable back into a birthdate.
//
// Rules (documented explicitly, since there is no single universal
// standard for a couple of the edge cases):
//
// 1. Timezone: the reference date is always taken as a calendar date in
//    Asia/Bangkok (UTC+7, no DST, so this is a fixed offset — safe to
//    compute without a timezone database).
//
// 2. Full-year age: age = referenceYear - birthYear, minus 1 if the
//    customer's birthday (month, day) has not yet occurred by the
//    reference date's (month, day) in the reference year.
//
// 3. February 29 birthdates: we never construct "the birthday in the
//    reference year" as an actual Date (that silently rolls Feb 29 into
//    Mar 1 or Mar 2 depending on JS engine/locale quirks — unreliable).
//    Instead we compare (month, day) tuples directly:
//        hasHadBirthdayThisYear = [refMonth, refDay] >= [birthMonth, birthDay]
//    For a Feb-29 birthdate this means: in a non-leap reference year,
//    the birthday is treated as reached on **March 1** (since Feb 28 as
//    (2,28) is still less than (2,29), and Mar 1 as (3,1) is greater).
//    This is a documented convention, not a legal ruling — flagged here
//    so it can be revisited if the business ever needs a different rule.
//
// 4. Calendar validity: birthdate must be a real calendar date. We
//    reject Apr 31, Feb 30, Feb 29 in a non-leap birth year, month 0/13,
//    day 0, etc. by round-tripping through Date.UTC and checking the
//    components come back unchanged — never by trusting JS's silent
//    date-rollover behavior (e.g. new Date(2021,1,29) silently becoming
//    Mar 1 2021).
//
// 5. Future birthdates: if the computed age would be negative (birthdate
//    is after the reference date), the result is invalid.
//
// 6. Implausible ages: ages outside [0, 130] are treated as invalid —
//    almost certainly bad input data, not a real customer.
//
// In every invalid/unavailable case this returns `{ age: null, reason }`
// — NEVER a fallback of 0 or any guessed number. Callers must persist
// NULL and may use `reason` for a data-quality report (never for
// per-customer logging of the reason next to identifying info).

const MIN_PLAUSIBLE_AGE = 0;
const MAX_PLAUSIBLE_AGE = 130;

/**
 * @param {string} birthdateStr - "YYYY-MM-DD", Gregorian (ค.ศ.) year.
 * @param {Date} referenceDateUtc - the moment to compute age as of
 *   (e.g. a payment row's created_at, parsed as UTC).
 * @returns {{ age: number, reason: null } | { age: null, reason: string }}
 */
function computeAgeAtPurchase(birthdateStr, referenceDateUtc) {
  if (!birthdateStr || typeof birthdateStr !== 'string') {
    return { age: null, reason: 'missing_birthdate' };
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdateStr.trim());
  if (!m) {
    return { age: null, reason: 'unparseable_birthdate' };
  }
  const by = parseInt(m[1], 10);
  const bm = parseInt(m[2], 10);
  const bd = parseInt(m[3], 10);

  if (!isRealCalendarDate(by, bm, bd)) {
    return { age: null, reason: 'invalid_calendar_date' };
  }
  // Gregorian (ค.ศ.) sanity range — matches the same bound already
  // enforced when birthdate was collected (see the old pay.js
  // sanitizeBirthdate, which capped 1900–2100).
  if (by < 1900 || by > 2100) {
    return { age: null, reason: 'year_out_of_range' };
  }

  if (!(referenceDateUtc instanceof Date) || isNaN(referenceDateUtc.getTime())) {
    return { age: null, reason: 'missing_or_invalid_reference_date' };
  }

  const bkk = toBangkokYmd(referenceDateUtc);

  let age = bkk.y - by;
  const hasHadBirthdayThisYear = (bkk.m > bm) || (bkk.m === bm && bkk.d >= bd);
  if (!hasHadBirthdayThisYear) age -= 1;

  if (age < MIN_PLAUSIBLE_AGE) {
    return { age: null, reason: 'future_birthdate' };
  }
  if (age > MAX_PLAUSIBLE_AGE) {
    return { age: null, reason: 'implausible_age' };
  }

  return { age, reason: null };
}

// Real-calendar-date check: round-trip through Date.UTC and verify the
// components didn't silently roll over (JS Date auto-normalizes
// out-of-range days/months instead of throwing).
function isRealCalendarDate(y, mo, d) {
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return false;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// Convert a UTC instant to its Asia/Bangkok calendar date (fixed
// UTC+7, no DST — safe as pure arithmetic, no timezone database needed).
function toBangkokYmd(dateUtc) {
  const bkkMs = dateUtc.getTime() + 7 * 60 * 60 * 1000;
  const bkk = new Date(bkkMs);
  return { y: bkk.getUTCFullYear(), m: bkk.getUTCMonth() + 1, d: bkk.getUTCDate() };
}

export { computeAgeAtPurchase, isRealCalendarDate, toBangkokYmd };
