// Prints what each preset in js/presets.js matches in the current tree, and what
// each mechanic's "pick all notables" button would pick. Run it after a patch
// update: a preset is a rule over stat text, and GGG rewording a stat empties it.
//
// usage: node tools/check-presets.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTree } from "../js/tree.js";
import { PRESETS, presetNodes } from "../js/presets.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const T = buildTree(JSON.parse(readFileSync(join(root, "data/atlas.json"), "utf8")));

let bad = 0;
for (const p of PRESETS) {
  const nodes = presetNodes(p, T.list);
  if (!nodes.length) bad++;
  console.log(`\n${p.name} — ${nodes.length} nodes${nodes.length ? "" : "   <-- EMPTY"}`);
  const byName = new Map();
  for (const n of nodes) byName.set(`${n.type} ${n.name}`, (byName.get(`${n.type} ${n.name}`) || 0) + 1);
  for (const [k, c] of byName) console.log(`  ${k}${c > 1 ? ` ×${c}` : ""}`);
}

console.log("\nNotables per mechanic");
const per = new Map();
for (const n of T.list) {
  if (n.type !== "notable") continue;
  const k = n.category || "(no mechanic)";
  per.set(k, [...(per.get(k) || []), n.name]);
}
for (const [k, names] of [...per].sort()) console.log(`  ${k} (${names.length}): ${names.join(", ")}`);

process.exit(bad ? 1 : 0);
