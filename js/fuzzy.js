// Fuzzy matching in the style of fzf: the query has to appear as a subsequence of
// the target, and the score rewards the match a human would have meant — one
// contiguous run, landing at the start of a word, early in the string. So "pcksz"
// finds "increased Pack Size", but "Pack Size" outranks it, and a node actually
// named for the thing outranks one that merely mentions it.
//
// A query splits on whitespace and every term has to hit something. That is what
// makes "breach pack" work: those two words appear in that order nowhere on a
// Breach node, but one matches the wheel's name and the other its stat line.

export const MISS = -Infinity;

const MATCH = 16;       // per matched character
const BOUNDARY = 10;    // ...and again if it starts a word
const CONSEC = 8;       // ...and again if it directly follows the previous match
const GAP_START = 5;    // cost of opening a gap
const GAP_EXTEND = 2;   // ...per character it runs on for
const LEAD_MAX = 12;    // cap on the "started late in the string" penalty

// Gaps are priced steeply on purpose. Most fuzzy finders search filenames, where
// a match jumping between word starts ("mvc" -> "ModelViewController") is exactly
// what was meant, so they let the boundary bonus cover the gap. Half the corpus
// here is prose — "Breach monsters in your maps have 10% increased..." — and in a
// sentence that long almost any six letters appear as a subsequence across six
// separate words. At GAP_EXTEND 1 those coincidences scored two thirds of a real
// match; at 2 the gap outruns the boundary bonus and they fall off the list.

// Stat lines run to ~120 characters; the cap is slack above that, and keeps the
// scratch buffers from being sized by some pathological input.
const MAXLEN = 240;
const NEG = -(1 << 28);
const LIVE = NEG >> 1;  // anything above this came from a real match

let cap = 0, rowA = null, rowB = null, bon = null;
function ensure(n) {
  if (n <= cap) return;
  cap = Math.max(n, 512);
  rowA = new Int32Array(cap);
  rowB = new Int32Array(cap);
  bon = new Int32Array(cap);
}

// A word character for boundary purposes. Both sides are already lowercased, so
// there is no camelCase signal to read — "20%" and "Pack" both start words.
function isWord(c) {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
}

// Both arguments must already be lowercase. Returns MISS if `q` is not a
// subsequence of `h`; otherwise the score of its best alignment.
export function scoreTerm(q, h) {
  const m = q.length;
  const n = Math.min(h.length, MAXLEN);
  if (!m || m > n) return MISS;

  // Cheap subsequence reject. Almost every candidate dies here, so the dynamic
  // program below only ever runs on strings that can actually match.
  for (let i = 0, j = 0; i < m; i++) {
    const c = q.charCodeAt(i);
    while (j < n && h.charCodeAt(j) !== c) j++;
    if (j === n) return MISS;
    j++;
  }

  ensure(n);
  for (let j = 0; j < n; j++) {
    bon[j] = j === 0 || !isWord(h.charCodeAt(j - 1)) ? BOUNDARY : 0;
  }

  // prev[j] is the best score for matching q[0..i] with q[i] landing on h[j].
  let prev = rowA, cur = rowB;
  const q0 = q.charCodeAt(0);
  for (let j = 0; j < n; j++) {
    prev[j] = h.charCodeAt(j) === q0 ? MATCH + bon[j] - Math.min(j, LEAD_MAX) : NEG;
  }

  for (let i = 1; i < m; i++) {
    const qi = q.charCodeAt(i);
    cur[0] = NEG;
    // The gap penalty is affine, so the best predecessor separated by a gap can be
    // carried along in a running maximum instead of rescanned — which is what keeps
    // this linear in the target's length rather than quadratic.
    let run = NEG; // max over k <= j-2 of prev[k] + GAP_EXTEND*k
    for (let j = 1; j < n; j++) {
      if (j >= 2 && prev[j - 2] > LIVE) {
        const v = prev[j - 2] + GAP_EXTEND * (j - 2);
        if (v > run) run = v;
      }
      let carry = prev[j - 1] > LIVE ? prev[j - 1] + CONSEC : NEG;
      if (run > LIVE) {
        const v = run - GAP_START - GAP_EXTEND * (j - 2);
        if (v > carry) carry = v;
      }
      cur[j] = carry > LIVE && h.charCodeAt(j) === qi ? carry + MATCH + bon[j] : NEG;
    }
    const t = prev; prev = cur; cur = t;
  }

  let best = NEG;
  for (let j = 0; j < n; j++) if (prev[j] > best) best = prev[j];
  return best > LIVE ? best : MISS;
}

// What a term scores against its perfect target: contiguous, at a word boundary,
// at the very start. Everything real is measured as a fraction of this.
export function idealScore(term) {
  return term.length * MATCH + BOUNDARY + (term.length - 1) * CONSEC;
}

// Being a subsequence is too weak a bar to highlight on. Search is a highlight,
// not a filter — 300 lit nodes tell you nothing — so a term also has to clear a
// fraction of its ideal to count. 0.6 is where the two populations separate:
// substring hits never fall below ~0.85 however deep in a line they sit, real
// acronym queries ("pcksz" for Pack Size) land around 0.76, and the sentence-wide
// coincidences sit below 0.55. Pushing it to 0.7 starts taking the acronyms too.
const MIN_RATIO = 0.6;

// Lowercase, whitespace-split. Returns null for an empty query so callers can
// treat "no search" and "search matching nothing" as the different things they are.
export function parseQuery(s) {
  const terms = String(s).toLowerCase().split(/\s+/).filter(Boolean);
  return terms.length ? terms : null;
}

// Every term must hit at least one of the fields, but not necessarily the same
// one. The score is the sum of each term's best field.
export function scoreFields(terms, fields) {
  let total = 0;
  for (const t of terms) {
    const floor = idealScore(t) * MIN_RATIO;
    let best = MISS;
    for (const f of fields) {
      const s = scoreTerm(t, f);
      if (s > best) best = s;
    }
    if (best === MISS || best < floor) return MISS;
    total += best;
  }
  return total;
}
