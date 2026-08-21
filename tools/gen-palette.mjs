// Derive the mechanic palette.
//
// A handful of mechanics have a colour the game already taught players (Blight is
// green, Delve is azurite blue, the Exarch is fire) — those are pinned. The rest
// are chosen by farthest-point selection over a candidate grid so every wheel
// stays visually apart, then matched to a mechanic by whichever free colour sits
// nearest its thematic hue hint.
//
// Usage: node tools/gen-palette.mjs   → prints the table to paste into js/palette.js

const srgb = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
function labOf([r, g, b]) {
  const [R, G, B] = [r, g, b].map((v) => srgb(v / 255));
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function hsl2rgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const t = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
          : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return t.map((v) => Math.round((v + m) * 255));
}
const hex = (rgb) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hueOf = (h) => {
  const [r, g, b] = rgbOf(h).map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  const q = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return q * 60;
};

// Pinned: the colour is part of the mechanic's identity.
const ANCHORS = {
  "Blight":               "#4fc47a",
  "Breach":               "#c05ce6",
  "Delve":                "#3f8fe0",
  "Delirium":             "#f0aede",
  "Bestiary":             "#e08a3c",
  "Betrayal":             "#d0455f",
  "Harvest":              "#a8d44a",
  "The Searing Exarch":   "#f05a2f",
  "The Eater of Worlds":  "#7a3f8f",
  "The Shaper and Elder": "#c9d8e8",
  "Abyss":                "#6b4fc4",
  "Legion":               "#efe3b0",
  "Ultimatum":            "#9d9d9d",
  "Vaal Side Areas":      "#5f9c33",
};

// Everything else: a hue the mechanic leans toward, honoured when a free colour
// is available near it. Purely a preference — separation wins.
const HINTS = {
  "Atlas Memories":      250,
  "Beyond":              310,
  "Conquerors":          220,
  "Divination Cards":     45,
  "Essence":             235,
  "Expedition":           38,
  "Heist":               170,
  "Incursion":           150,
  "Labyrinth":            35,
  "Maps":                 30,
  "Mercenaries":          15,
  "Ritual":              345,
  "Rogue Exiles":          5,
  "Scarabs":              50,
  "Settlers of Kalguur":  195,
  "Shrines":              185,
  "Strongboxes":          25,
  "Synthesis":           200,
  "Torment":             270,
};

// Reserve the UI's own signal colours so a mechanic never mimics them.
const RESERVED = ["#ffd76b" /*picked*/, "#3fd0c9" /*path*/, "#8a3232" /*blocked*/, "#d05a5a" /*unreachable*/, "#12161c" /*bg*/].map((h) => labOf(rgbOf(h)));

// Saturation stays inside the app's muted range — a maximally-separated palette
// is worthless if half of it is neon against a #12161c background.
const cands = [];
for (let h = 0; h < 360; h += 4)
  for (let s = 28; s <= 64; s += 6)
    for (let l = 44; l <= 78; l += 4) {
      const rgb = hsl2rgb(h, s, l);
      const lab = labOf(rgb);
      if (lab[0] < 46 || lab[0] > 86) continue;                 // readable on #12161c
      if (RESERVED.some((r) => dE(lab, r) < 20)) continue;
      cands.push({ hex: hex(rgb), lab, hue: h });
    }

// One pass per mechanic, in hint order: take the candidate with the best
// trade-off between staying clear of every colour already chosen and honouring
// the mechanic's hue. HUE_COST sets the exchange rate — 0.35 means a 30° hue
// compromise is worth about 10 ΔE of extra separation.
const HUE_COST = 0.35;
const hueErr = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

const chosen = Object.values(ANCHORS).map((h) => ({ lab: labOf(rgbOf(h)) }));
const out = { ...ANCHORS };
for (const name of Object.keys(HINTS).sort()) {
  let best = null, bestScore = -Infinity;
  for (const c of cands) {
    let d = Infinity;
    for (const q of chosen) d = Math.min(d, dE(c.lab, q.lab));
    const score = d - HUE_COST * hueErr(HINTS[name], c.hue);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  out[name] = best.hex;
  chosen.push(best);
}

const all = Object.keys(out).sort();
const w = Math.max(...all.map((n) => n.length)) + 3;
console.log("export const CATEGORY_COLOR = {");
for (const n of all) console.log(`  ${(JSON.stringify(n) + ":").padEnd(w)} ${JSON.stringify(out[n])},`);
console.log("};");

let worst = Infinity, wp = null;
for (let i = 0; i < all.length; i++)
  for (let j = i + 1; j < all.length; j++) {
    const d = dE(labOf(rgbOf(out[all[i]])), labOf(rgbOf(out[all[j]])));
    if (d < worst) { worst = d; wp = [all[i], all[j]]; }
  }
console.error(`\nmin ΔE ${worst.toFixed(1)} between ${wp[0]} and ${wp[1]}`);
