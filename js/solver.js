// Steiner-tree solver worker: minimum-point connected subtree containing root + all picks,
// avoiding blocked nodes. Unit node costs make edge-count Steiner equivalent (tree: |V|-1 = |E|).
//
// Every answer is exact, at any number of picks, via the tree-decomposition DP in
// steiner-exact.js. A greedy heuristic still runs first, because it lands in a few
// milliseconds and gives the user something on screen while the real solve runs;
// Dreyfus-Wagner is kept as a fallback for the small cases if the decomposition
// ever comes up short.

import { buildDecomposition, solveExact } from "./steiner-exact.js";

let N = 0, offsets = null, neighbors = null, rootIdx = -1, ring = null;

const INF = 0x3fffffff;

// How long the exact solve gets before we keep the heuristic answer instead.
// Measured worst case on the full atlas is well under a second, so this is a
// backstop against a pathological blocked set, not a working budget.
const EXACT_BUDGET_MS = 5000;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.kind === "init") {
    N = msg.n;
    offsets = msg.offsets;
    neighbors = msg.neighbors;
    ring = msg.ring;
    rootIdx = msg.root;
    return;
  }
  if (msg.kind === "solve") solve(msg);
};

// Routes across a wheel are routinely tied: on a wheel with an inner and an outer
// ring, both reach the same notable in the same number of hops, so the tree costs
// the same either way. Cost alone can't choose, and the arbitrary winner is often
// the one that cuts across the middle — which reads as a detour even though it is
// not one. Prefer the parent that keeps us on the ring we are already on.
//
// This only ever fires between candidates of equal distance, so it cannot change
// what a solve costs — only which of the equally-cheap answers gets shown.
function prefer(v, cand, cur) {
  if (cur < 0 || cand === cur) return false;
  return ring[cand] === ring[v] && ring[cur] !== ring[v];
}

function solve({ seq, picks, blocked }) {
  const blockedMask = new Uint8Array(N);
  for (const b of blocked) blockedMask[b] = 1;

  const distFromRoot = bfs(rootIdx, blockedMask);
  const unreachable = picks.filter((p) => blockedMask[p] || distFromRoot[p] === INF);
  const terminals = [rootIdx, ...picks.filter((p) => !blockedMask[p] && distFromRoot[p] !== INF)];

  if (terminals.length === 1) {
    post(seq, [rootIdx], 0, true, unreachable);
    return;
  }

  // Fast phase: one nearest-insertion greedy pass with reroute improvement. It
  // lands in a few milliseconds, so the user gets a shape on screen immediately.
  // No restarts here — the exact answer is about to replace this one anyway, and
  // 40 restarts would add a couple hundred milliseconds to every single solve.
  let best = improve(greedy(terminals, blockedMask, null), terminals, blockedMask);
  post(seq, [...best], best.size - 1, null, unreachable);

  // Exact phase. Take its tree even when the sizes tie: it costs the same and it
  // has the ring tie-break baked into its edge weights, so it is the nicer one.
  const exact = exactTree(terminals, blocked, blockedMask);
  if (exact) {
    if (exact.size <= best.size) best = exact;
    post(seq, [...best], best.size - 1, true, unreachable);
    return;
  }

  // No decomposition, or it ran out of time. Dreyfus-Wagner still covers the small
  // cases exactly.
  if (terminals.length - 1 <= 10) {
    const dw = dreyfusWagner(terminals, blockedMask);
    if (dw && dw.size < best.size) best = dw;
    post(seq, [...best], best.size - 1, true, unreachable);
    return;
  }

  // Past that the heuristic is all we have, so now its quality is worth paying
  // for: restart it from shuffled insertion orders and keep the best.
  const t0 = Date.now();
  let rng = (0x9e3779b9 ^ (terminals.length * 2654435761)) >>> 0;
  for (let tries = 0; tries < 40 && Date.now() - t0 < 250; tries++) {
    rng = (rng * 1664525 + 1013904223) >>> 0;
    const cand = improve(greedy(terminals, blockedMask, rng), terminals, blockedMask);
    if (cand.size < best.size) best = cand;
  }
  post(seq, [...best], best.size - 1, false, unreachable);
}

// --- Exact solve over a tree decomposition -----------------------------------

// The decomposition depends only on which nodes are blocked, and blocking is rare
// next to picking, so the last one is worth holding on to. A failed build is
// cached too — if min-fill couldn't handle this graph it won't next time either.
let tdCache = null, tdKey = null;

function exactTree(terminals, blocked, blockedMask) {
  const key = blocked.slice().sort((a, b) => a - b).join(",");
  if (tdKey !== key) {
    tdCache = buildDecomposition(N, offsets, neighbors, blockedMask, rootIdx);
    tdKey = key;
  }
  if (!tdCache) return null;

  const terminalMask = new Uint8Array(N);
  for (const t of terminals) terminalMask[t] = 1;
  const res = solveExact(tdCache, terminalMask, Date.now() + EXACT_BUDGET_MS, ring);
  if (!res) return null;

  const set = new Set([rootIdx]);
  for (const [a, b] of res.edges) { set.add(a); set.add(b); }
  return set;
}

function post(seq, nodesArr, points, optimal, unreachable) {
  self.postMessage({ seq, nodes: nodesArr, points, optimal, unreachable });
}

// --- BFS utilities -----------------------------------------------------------

function bfs(src, blockedMask) {
  const dist = new Int32Array(N).fill(INF);
  const q = new Int32Array(N);
  let head = 0, tail = 0;
  dist[src] = 0; q[tail++] = src;
  while (head < tail) {
    const u = q[head++];
    for (let i = offsets[u]; i < offsets[u + 1]; i++) {
      const v = neighbors[i];
      if (blockedMask[v] || dist[v] !== INF) continue;
      dist[v] = dist[u] + 1;
      q[tail++] = v;
    }
  }
  return dist;
}

// Multi-source BFS from tree; stopAtSet: return first reached member of that set (or a specific
// target). Returns {target, path} where path excludes tree nodes, ordered target-first.
function reachFromTree(treeSet, blockedMask, { target = -1, targetSet = null }) {
  const dist = new Int32Array(N).fill(INF);
  const par = new Int32Array(N).fill(-1);
  const q = new Int32Array(N);
  let head = 0, tail = 0;
  for (const s of treeSet) { dist[s] = 0; q[tail++] = s; }
  let hit = -1;
  if (target !== -1 && treeSet.has(target)) return { target, path: [] };
  while (head < tail) {
    const u = q[head++];
    if (u === target || (targetSet && targetSet.has(u) && dist[u] > 0)) { hit = u; break; }
    for (let i = offsets[u]; i < offsets[u + 1]; i++) {
      const v = neighbors[i];
      if (blockedMask[v]) continue;
      if (dist[v] !== INF) {
        // already reached; u is an equally-short way in, so it may be a nicer one
        if (dist[v] === dist[u] + 1 && prefer(v, u, par[v])) par[v] = u;
        continue;
      }
      dist[v] = dist[u] + 1;
      par[v] = u;
      q[tail++] = v;
    }
  }
  if (hit === -1) return { target: null, path: null };
  const path = [];
  for (let v = hit; v !== -1 && !treeSet.has(v); v = par[v]) path.push(v);
  return { target: hit, path };
}

// --- Greedy insertion heuristic ---------------------------------------------

function greedy(terminals, blockedMask, seed) {
  const tree = new Set([terminals[0]]);
  if (seed === null) {
    const remaining = new Set(terminals.slice(1));
    while (remaining.size) {
      for (const r of [...remaining]) if (tree.has(r)) remaining.delete(r);
      if (!remaining.size) break;
      const { target, path } = reachFromTree(tree, blockedMask, { targetSet: remaining });
      if (target === null) break;
      for (const v of path) tree.add(v);
      remaining.delete(target);
    }
  } else {
    const order = terminals.slice(1);
    let s = seed;
    for (let i = order.length - 1; i > 0; i--) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const j = s % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const t of order) {
      if (tree.has(t)) continue;
      const { path } = reachFromTree(tree, blockedMask, { target: t });
      if (!path) continue;
      for (const v of path) tree.add(v);
    }
  }
  return tree;
}

// --- Improvement: prune + terminal-branch reroute ----------------------------

function improve(tree, terminals, blockedMask) {
  const isTerminal = new Uint8Array(N);
  for (const t of terminals) isTerminal[t] = 1;
  const cur = new Set(tree);
  prune(cur, isTerminal);
  for (let round = 0; round < 20; round++) {
    let improved = false;
    for (const t of terminals) {
      if (t === rootIdx) continue;
      const removed = peelBranch(cur, t, isTerminal);
      if (removed.length === 0) continue;
      const { path } = reachFromTree(cur, blockedMask, { target: t });
      if (path && path.length < removed.length) {
        for (const v of path) cur.add(v);
        improved = true;
      } else {
        for (const v of removed) cur.add(v);
      }
    }
    if (!improved) break;
  }
  prune(cur, isTerminal);
  return cur;
}

function degreeIn(cur, v) {
  let d = 0;
  for (let i = offsets[v]; i < offsets[v + 1]; i++) if (cur.has(neighbors[i])) d++;
  return d;
}

function prune(cur, isTerminal) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const v of cur) {
      if (isTerminal[v] || v === rootIdx) continue;
      if (degreeIn(cur, v) <= 1) { cur.delete(v); changed = true; }
    }
  }
}

// Remove terminal t (if it's a leaf) plus its chain of non-terminal degree-2 support nodes.
function peelBranch(cur, t, isTerminal) {
  if (degreeIn(cur, t) !== 1) return [];
  const removed = [];
  let v = t;
  while (true) {
    let nextNode = -1;
    for (let i = offsets[v]; i < offsets[v + 1]; i++) {
      const u = neighbors[i];
      if (cur.has(u)) { nextNode = u; break; }
    }
    cur.delete(v);
    removed.push(v);
    if (nextNode === -1) break;
    v = nextNode;
    if (isTerminal[v] || v === rootIdx || degreeIn(cur, v) !== 1) break;
  }
  return removed;
}

// --- Exact Dreyfus-Wagner ----------------------------------------------------

function dreyfusWagner(terminals, blockedMask) {
  const anchor = terminals[0];
  const others = terminals.slice(1);
  const t = others.length;
  const SUB = 1 << t;
  const dp = new Array(SUB);
  const predNode = new Array(SUB);
  const predSplit = new Array(SUB);

  for (let S = 1; S < SUB; S++) {
    dp[S] = new Int32Array(N).fill(INF);
    predNode[S] = new Int32Array(N).fill(-1);
    predSplit[S] = new Int32Array(N).fill(0);
  }
  for (let i = 0; i < t; i++) dp[1 << i][others[i]] = 0;

  for (let S = 1; S < SUB; S++) {
    const d = dp[S];
    for (let A = (S - 1) & S; A > 0; A = (A - 1) & S) {
      const B = S ^ A;
      if (A < B) continue; // each unordered partition once
      const da = dp[A], db = dp[B];
      const pn = predNode[S], ps = predSplit[S];
      for (let v = 0; v < N; v++) {
        const c = da[v] + db[v];
        if (c < d[v]) { d[v] = c; pn[v] = -2; ps[v] = A; }
      }
    }
    dialRelax(d, predNode[S], blockedMask);
  }
  const full = SUB - 1;
  if (dp[full][anchor] >= INF) return null;

  const set = new Set();
  const stack = [[full, anchor]];
  while (stack.length) {
    const [S, v] = stack.pop();
    set.add(v);
    const pn = predNode[S][v];
    if (pn === -1) continue;
    if (pn === -2) {
      const A = predSplit[S][v];
      stack.push([A, v], [S ^ A, v]);
    } else {
      stack.push([S, pn]);
    }
  }
  return set;
}

// Unit-weight Dijkstra via bucket queue with immutable entries (stale entries skipped).
function dialRelax(d, pn, blockedMask) {
  const heads = new Int32Array(N + 2).fill(-1);
  const ev = [], en = [];
  let maxd = 0;
  const push = (v, b) => {
    ev.push(v); en.push(heads[b]); heads[b] = ev.length - 1;
    if (b > maxd) maxd = b;
  };
  for (let v = 0; v < N; v++) if (d[v] < INF && d[v] <= N) push(v, d[v]);
  for (let b = 0; b <= maxd; b++) {
    for (let e = heads[b]; e !== -1; e = en[e]) {
      const v = ev[e];
      if (d[v] !== b) continue;
      for (let i = offsets[v]; i < offsets[v + 1]; i++) {
        const u = neighbors[i];
        if (blockedMask[u]) continue;
        if (b + 1 < d[u]) {
          d[u] = b + 1;
          pn[u] = v;
          if (b + 1 <= N) push(u, b + 1);
        } else if (b + 1 === d[u] && pn[u] !== -2 && prefer(u, v, pn[u])) {
          // Same distance, prettier approach. pn[u] === -2 marks a subset merge,
          // which carries the split this entry was built from — never overwrite
          // that with a plain parent edge.
          pn[u] = v;
        }
      }
    }
  }
}
