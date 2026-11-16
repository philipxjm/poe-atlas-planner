// Checks that the exact solver still works on the current tree. Run it after a
// patch update: the exact phase needs a tree decomposition narrow enough to
// encode, and when a new atlas is too wide for it the planner does not break —
// it quietly answers "best found (heuristic)" past ten picks instead.
//
// usage: node tools/check-solver.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTree } from "../js/tree.js";
import { buildDecomposition, solveExact } from "../js/steiner-exact.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const T = buildTree(JSON.parse(readFileSync(join(root, "data/atlas.json"), "utf8")));
const N = T.list.length;

let t0 = Date.now();
const td = buildDecomposition(N, T.csr.offsets, T.csr.neighbors, new Uint8Array(N), T.rootIndex);
if (!td) {
  console.log(`no decomposition for ${N} nodes: every elimination order tried was too wide`);
  process.exit(1);
}
console.log(`decomposition: ${N} nodes, widest bag ${td.treewidth + 1}, ${Date.now() - t0} ms`);

// every notable at once: far past what Dreyfus-Wagner or the heuristic can vouch for
const ring = new Int32Array(N);
T.list.forEach((n, i) => { ring[i] = n.group * 8 + n.orbit; });
const terminals = new Uint8Array(N);
terminals[T.rootIndex] = 1;
let picks = 0;
T.list.forEach((n, i) => { if (n.type === "notable") { terminals[i] = 1; picks++; } });

t0 = Date.now();
const res = solveExact(td, terminals, Date.now() + 60000, ring);
if (!res) {
  console.log(`exact solve of ${picks} notables failed or ran past a minute`);
  process.exit(1);
}
console.log(`all ${picks} notables: ${res.cost} points, ${Date.now() - t0} ms`);
