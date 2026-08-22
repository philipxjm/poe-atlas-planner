// The plan travels in the URL fragment: which nodes are picked, which are blocked.
//
// Ids rather than indices into the node list. Indices pack smaller — the list is
// ~1000 long, so 10 bits each against a varint's 16-plus — but they are only
// meaningful against the exact data file that produced them. Drop a patch's new
// atlas.json in and every index after the first inserted node shifts by one, so
// an old link still decodes, still looks plausible, and points at the wrong
// passives. Ids can only fail the honest way: one that no longer exists is not
// found and is skipped. That is worth the extra ~130 characters at 120 picks.
//
// Sorted, then delta-coded, then varint, then base64url. Sorting is what makes
// the deltas small, and costs nothing since a set of picks has no order anyway.

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// Own base64 rather than btoa/Buffer so the same code runs in the page and in tests.
function toB64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += ALPHA[(n >> 18) & 63] + ALPHA[(n >> 12) & 63];
    if (b !== undefined) out += ALPHA[(n >> 6) & 63];
    if (c !== undefined) out += ALPHA[n & 63];
  }
  return out;
}

function fromB64(s) {
  const bytes = [];
  let acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = ALPHA.indexOf(s[i]);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255); }
  }
  return bytes;
}

function putVarint(b, v) {
  while (v >= 128) { b.push((v & 127) | 128); v >>>= 7; }
  b.push(v);
}

function getVarint(bytes, st) {
  let v = 0, shift = 0;
  while (st.i < bytes.length) {
    const c = bytes[st.i++];
    v |= (c & 127) << shift;
    if (!(c & 128)) return v >>> 0;
    shift += 7;
    if (shift > 28) return null;
  }
  return null;
}

function putList(b, list) {
  const sorted = list.map(Number).filter((v) => Number.isInteger(v) && v >= 0).sort((x, y) => x - y);
  putVarint(b, sorted.length);
  let prev = 0;
  for (const v of sorted) { putVarint(b, v - prev); prev = v; }
}

function getList(bytes, st) {
  const n = getVarint(bytes, st);
  if (n === null || n > 4096) return null;
  const out = [];
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const d = getVarint(bytes, st);
    if (d === null) return null;
    prev += d;
    out.push(String(prev));
  }
  return out;
}

export function encodeState(picks, blocks) {
  if (!picks.length && !blocks.length) return "";
  const b = [];
  putList(b, picks);
  putList(b, blocks);
  return toB64(b);
}

export function decodeState(s) {
  const bytes = fromB64(s);
  if (!bytes) return null;
  const st = { i: 0 };
  const picks = getList(bytes, st);
  if (!picks) return null;
  const blocks = getList(bytes, st) || [];
  return { picks, blocks };
}

/** An empty plan gets no fragment at all, so a fresh page keeps a clean URL. */
export function buildHash(picks, blocks) {
  const p = encodeState(picks, blocks);
  return p ? "#p=" + p : "";
}

export function parseHash(hash) {
  const h = String(hash).replace(/^#/, "");
  if (!h) return { picks: [], blocks: [] };

  const p = /(?:^|&)p=([A-Za-z0-9_-]+)/.exec(h);
  if (p) return decodeState(p[1]);

  // The first format wrote ids in decimal, dot separated. Read forever, never
  // written again — links get shared into places that outlive the format.
  const s = /(?:^|&)s=([^&]*)/.exec(h);
  const b = /(?:^|&)b=([^&]*)/.exec(h);
  if (!s && !b) return null;
  const split = (m) => (m && m[1] ? m[1].split(".").filter(Boolean) : []);
  return { picks: split(s), blocks: split(b) };
}
