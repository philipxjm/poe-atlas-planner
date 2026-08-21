// Report the closest mechanic-colour pairs so no two wheels look the same.
// Usage: node tools/check-palette.mjs
import { CATEGORY_COLOR } from "../js/palette.js";

const srgb = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

function lab(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => srgb(parseInt(hex.slice(i, i + 2), 16) / 255));
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const names = Object.keys(CATEGORY_COLOR);
const labs = new Map(names.map((n) => [n, lab(CATEGORY_COLOR[n])]));
const pairs = [];
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const a = labs.get(names[i]), b = labs.get(names[j]);
    pairs.push({ d: Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), a: names[i], b: names[j] });
  }
}
pairs.sort((p, q) => p.d - q.d);

console.log(`${names.length} mechanics, ${pairs.length} pairs`);
console.log(`closest ΔE: ${pairs[0].d.toFixed(1)}   median: ${pairs[(pairs.length / 2) | 0].d.toFixed(1)}`);
console.log("\n15 closest pairs:");
for (const p of pairs.slice(0, 15)) {
  console.log(`  ${p.d.toFixed(1).padStart(5)}  ${p.a.padEnd(22)} ${p.b}`);
}
const tight = pairs.filter((p) => p.d < 18);
console.log(`\n${tight.length} pair(s) under ΔE 18`);
process.exit(tight.length ? 1 : 0);
