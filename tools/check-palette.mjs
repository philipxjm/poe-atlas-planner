// Two guards, because the palette has two jobs.
//
//   identity  — CATEGORY_COLOR, shown in the key and the cluster rings. No two
//               mechanics may look alike, so the bar is high (ΔE 18).
//   fills     — what nodeColor() actually paints. Muted, so mechanics are closer
//               together (bar ΔE 8) but every one of them must stay far from the
//               selection colours (bar ΔE 20) and below them in lightness — that
//               separation is the whole reason the fills are muted.
//
// Usage: node tools/check-palette.mjs
import { CATEGORY_COLOR, nodeColor } from "../js/palette.js";

const srgb = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

function lab(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => srgb(parseInt(hex.slice(i, i + 2), 16) / 255));
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const names = Object.keys(CATEGORY_COLOR);
let failed = 0;

function closest(entries) {
  const pairs = [];
  for (let i = 0; i < entries.length; i++)
    for (let j = i + 1; j < entries.length; j++)
      pairs.push({ d: dE(entries[i].lab, entries[j].lab), a: entries[i].name, b: entries[j].name });
  return pairs.sort((p, q) => p.d - q.d);
}

// --- identity ---------------------------------------------------------------
const ident = closest(names.map((n) => ({ name: n, lab: lab(CATEGORY_COLOR[n]) })));
console.log(`identity: ${names.length} mechanics, ${ident.length} pairs`);
console.log(`  closest ΔE ${ident[0].d.toFixed(1)}   median ${ident[(ident.length / 2) | 0].d.toFixed(1)}`);
for (const p of ident.slice(0, 5)) console.log(`    ${p.d.toFixed(1).padStart(5)}  ${p.a.padEnd(22)} ${p.b}`);
const identTight = ident.filter((p) => p.d < 18);
console.log(`  ${identTight.length} pair(s) under ΔE 18${identTight.length ? "  <-- FAIL" : ""}`);
failed += identTight.length ? 1 : 0;

// --- fills ------------------------------------------------------------------
const RANKS = ["small", "notable", "keystone"];
const fills = [];
for (const n of names) for (const r of RANKS) fills.push({ name: `${n} (${r})`, rank: r, lab: lab(nodeColor(n, r)) });

console.log(`\nfills: ${fills.length} painted colours`);
let worstRank = null;
for (const r of RANKS) {
  const c = closest(fills.filter((f) => f.rank === r));
  console.log(`  ${r.padEnd(9)} closest ΔE ${c[0].d.toFixed(1).padStart(5)}  (${c[0].a} / ${c[0].b})`);
  if (!worstRank || c[0].d < worstRank.d) worstRank = c[0];
}
if (worstRank.d < 8) { console.log(`  <-- FAIL: ${worstRank.d.toFixed(1)} is under ΔE 8`); failed++; }

// --- fills vs the states they must never be mistaken for ---------------------
// Selection is the one that matters: if a plain node reads as picked or on-path,
// the mute has failed at its job.
const SELECTION = { picked: "#ffd76b", "picked ring": "#ffe9a8", path: "#3fd0c9" };
console.log("\nfills vs selection (bar: ΔE 20, and every fill darker):");
let selWorst = { d: Infinity }, brightest = { L: -1 };
for (const [k, c] of Object.entries(SELECTION)) {
  const sl = lab(c);
  for (const f of fills) {
    const d = dE(f.lab, sl);
    if (d < selWorst.d) selWorst = { d, f: f.name, k };
    if (f.lab[0] > brightest.L) brightest = { L: f.lab[0], f: f.name };
  }
}
const selL = Math.min(...Object.values(SELECTION).map((c) => lab(c)[0]));
console.log(`  closest  ΔE ${selWorst.d.toFixed(1)}  (${selWorst.f} vs ${selWorst.k})`);
console.log(`  brightest fill L* ${brightest.L.toFixed(1)} (${brightest.f}) vs dimmest selection L* ${selL.toFixed(1)}`);
if (selWorst.d < 20) { console.log("  <-- FAIL: a fill is too close to a selection colour"); failed++; }
if (brightest.L >= selL) { console.log("  <-- FAIL: a fill is as bright as a selection colour"); failed++; }

// Blocked/unreachable are advisory: both carry their own marks (an X, a solve
// failure), so proximity there is a smell rather than a defect.
const STATE = { unreachable: "#d05a5a", blocked: "#8a3232" };
let stWorst = { d: Infinity };
for (const [k, c] of Object.entries(STATE)) {
  const sl = lab(c);
  for (const f of fills) { const d = dE(f.lab, sl); if (d < stWorst.d) stWorst = { d, f: f.name, k }; }
}
console.log(`\nfills vs blocked/unreachable (advisory): closest ΔE ${stWorst.d.toFixed(1)}  (${stWorst.f} vs ${stWorst.k})`);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
