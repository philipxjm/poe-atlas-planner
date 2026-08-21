// Exact minimum Steiner tree, by dynamic programming over a tree decomposition.
//
// Dreyfus-Wagner costs 3^k in the number of picks, which is why it was capped at
// 10 and everything beyond fell back to a heuristic. This does not depend on the
// number of picks at all. It is exponential in the graph's *treewidth* instead,
// and the atlas is a sparse thing built from rings joined by corridors: its
// treewidth is 7, and 858 of its 903 bags hold two or three nodes. So 40 picks
// cost the same as 4.
//
// The decomposition depends only on which nodes are blocked, not on what is
// picked, so it is built once and reused across solves.
//
// Costs are counted in edges. A tree with V nodes has V-1 edges, so minimising
// edges is the same as minimising points, which is what the atlas charges for.

// Bag entries are held as one integer per node: 0 means "not in the partial
// solution", otherwise a block number saying which component it belongs to so
// far. Base MAX_BAG+1 keeps a whole bag in one 31-bit int, so states are plain
// map keys and the join loop stays arithmetic.
const MAX_BAG = 9;

function encodeLabels(labels, len, base) {
  let code = 0;
  for (let i = len - 1; i >= 0; i--) code = code * base + labels[i];
  return code;
}

function decodeLabels(code, len, base, out) {
  for (let i = 0; i < len; i++) { out[i] = code % base; code = (code / base) | 0; }
}

// Block numbers are only meaningful up to renaming, so states are stored in one
// canonical form: blocks numbered 1, 2, 3... in the order they first appear.
// Without this the same partition arrives under several keys and the tables grow
// without bound.
const canonSeen = new Int32Array(MAX_BAG + 2);
function canonicalize(labels, len) {
  canonSeen.fill(0);
  let next = 1;
  for (let i = 0; i < len; i++) {
    const l = labels[i];
    if (l === 0) continue;
    if (canonSeen[l] === 0) canonSeen[l] = next++;
    labels[i] = canonSeen[l];
  }
  return next - 1; // block count
}

// ---------------------------------------------------------------- decomposition

// Greedy min-fill elimination. Eliminating a node makes its surviving neighbours
// a clique; the node plus those neighbours is its bag. Picking the node that adds
// fewest new edges keeps the bags small, which is the whole ball game here.
// `last` is eliminated at the very end so its bag is a lone node — that gives the
// DP a root to finish at, and is why the atlas start is passed in as `last`.
function minFillOrder(verts, adj, last) {
  const g = new Map();
  for (const v of verts) g.set(v, new Set(adj.get(v)));
  const remaining = new Set(verts);
  remaining.delete(last);
  const order = [];
  const bags = new Map();

  while (remaining.size) {
    let best = -1, bestFill = Infinity, bestDeg = Infinity;
    for (const v of remaining) {
      const nb = g.get(v);
      if (nb.size > bestFill) continue; // fill is never below zero, so size bounds it
      let fill = 0;
      const arr = [...nb];
      for (let i = 0; i < arr.length && fill <= bestFill; i++)
        for (let j = i + 1; j < arr.length; j++)
          if (!g.get(arr[i]).has(arr[j])) fill++;
      if (fill < bestFill || (fill === bestFill && nb.size < bestDeg)) {
        best = v; bestFill = fill; bestDeg = nb.size;
      }
    }
    const nb = [...g.get(best)];
    if (nb.length + 1 > MAX_BAG) return null; // too wide to encode; caller falls back
    order.push(best);
    bags.set(best, [best, ...nb].sort((a, b) => a - b));
    for (let i = 0; i < nb.length; i++) {
      for (let j = i + 1; j < nb.length; j++) { g.get(nb[i]).add(nb[j]); g.get(nb[j]).add(nb[i]); }
      g.get(nb[i]).delete(best);
    }
    g.delete(best);
    remaining.delete(best);
  }
  order.push(last);
  bags.set(last, [last]);
  return { order, bags };
}

const LEAF = 0, INTRO_V = 1, FORGET_V = 2, INTRO_E = 3, JOIN = 4;

// Turn the elimination order into a "nice" decomposition: every step either adds
// a node to the bag, drops one, adds one edge, or merges two branches. Handling
// four narrow cases is what keeps the DP itself honest.
export function buildDecomposition(N, offsets, neighbors, blockedMask, rootIdx) {
  if (blockedMask && blockedMask[rootIdx]) return null;

  // Only the part of the graph still reachable from the atlas start can matter.
  const seen = new Uint8Array(N);
  const queue = [rootIdx];
  seen[rootIdx] = 1;
  for (let h = 0; h < queue.length; h++) {
    const u = queue[h];
    for (let i = offsets[u]; i < offsets[u + 1]; i++) {
      const v = neighbors[i];
      if ((blockedMask && blockedMask[v]) || seen[v]) continue;
      seen[v] = 1; queue.push(v);
    }
  }
  const verts = queue.slice();
  const adj = new Map();
  for (const v of verts) {
    const s = new Set();
    for (let i = offsets[v]; i < offsets[v + 1]; i++) if (seen[neighbors[i]]) s.add(neighbors[i]);
    adj.set(v, s);
  }

  const elim = minFillOrder(verts, adj, rootIdx);
  if (!elim) return null;
  const { order, bags } = elim;

  const elimIndex = new Map();
  order.forEach((v, i) => elimIndex.set(v, i));

  // Every bag but the root hangs off the bag of its earliest-eliminated other
  // member; that node's bag is guaranteed to contain everything this one keeps.
  const children = new Map(verts.map((v) => [v, []]));
  for (const v of order) {
    if (v === rootIdx) continue;
    const rest = bags.get(v).filter((u) => u !== v);
    let par = -1, parIdx = Infinity;
    for (const u of rest) if (elimIndex.get(u) < parIdx) { parIdx = elimIndex.get(u); par = u; }
    if (par !== -1) children.get(par).push(v);
  }

  // Each edge is introduced exactly once, at whichever endpoint leaves first —
  // that endpoint's bag holds both, and it is still in the bag at that point.
  const edgesAt = new Map(verts.map((v) => [v, []]));
  for (const v of verts) {
    for (const u of adj.get(v)) {
      if (v > u) continue;
      const owner = elimIndex.get(v) < elimIndex.get(u) ? v : u;
      edgesAt.get(owner).push([v, u]);
    }
  }

  const nodes = [];
  const add = (n) => (nodes.push(n), nodes.length - 1);
  const bagOf = (i) => nodes[i].bag;

  const introV = (child, v) => {
    const bag = [...bagOf(child), v].sort((a, b) => a - b);
    return add({ type: INTRO_V, bag, child, v });
  };
  const forgetV = (child, v) => {
    const bag = bagOf(child).filter((x) => x !== v);
    return add({ type: FORGET_V, bag, child, v });
  };

  // Children are eliminated before their parent, so a single forward pass over
  // the elimination order always finds a node's children already built.
  const built = new Map();
  for (const v of order) {
    const target = bags.get(v);
    const branches = [];
    for (const c of children.get(v)) {
      let node = forgetV(built.get(c), c);
      built.delete(c);
      const have = new Set(bagOf(node));
      for (const u of target) if (!have.has(u)) node = introV(node, u);
      branches.push(node);
    }
    let node;
    if (branches.length === 0) {
      node = add({ type: LEAF, bag: [] });
      for (const u of target) node = introV(node, u);
    } else {
      node = branches[0];
      for (let i = 1; i < branches.length; i++)
        node = add({ type: JOIN, bag: target.slice(), a: node, b: branches[i] });
    }
    for (const [a, b] of edgesAt.get(v)) node = add({ type: INTRO_E, bag: bagOf(node).slice(), child: node, a, b });
    built.set(v, node);
  }

  let maxBag = 0;
  for (const n of nodes) if (n.bag.length > maxBag) maxBag = n.bag.length;
  return {
    nodes, root: built.get(rootIdx), base: maxBag + 1,
    treewidth: maxBag - 1, reachable: seen, vertexCount: verts.length,
  };
}

// ---------------------------------------------------------------- the DP

// Ties are the rule, not the exception, on a graph of concentric rings: two ways
// round a wheel reach the same notable in the same number of hops. Cost alone
// can't choose, and the arbitrary winner is often the one cutting across the
// middle, which reads as a detour even though it isn't one.
//
// So charge each edge SCALE, plus 1 if it leaves the ring it started on. Any tree
// has fewer than SCALE edges, so the penalties can never add up to a whole edge:
// the DP still minimises edge count first, exactly as before, and only picks
// among the equally-cheap answers with what's left. `ring` is optional — without
// it every edge costs the same and the solver is indifferent, as it used to be.
const SCALE = 1024;

// Returns { edges: [[a,b],...], cost } for the cheapest tree spanning every
// terminal, or null if the deadline passes first. `cost` is in points, i.e. edges.
export function solveExact(td, terminalMask, deadlineMs, ring = null) {
  const { nodes, root, base } = td;
  // A tree can't have more edges than the graph has nodes, which is what keeps the
  // penalties sub-unit. On a graph big enough to break that, drop the preference
  // rather than the guarantee.
  if (td.vertexCount >= SCALE) ring = null;
  const cost = new Array(nodes.length);
  const back = new Array(nodes.length);
  const la = new Int32Array(MAX_BAG), lb = new Int32Array(MAX_BAG), lc = new Int32Array(MAX_BAG);
  const uf = new Int32Array(MAX_BAG);
  const firstA = new Int32Array(MAX_BAG + 2), firstB = new Int32Array(MAX_BAG + 2);
  const find = (x) => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };

  // A table is only read by its parent, so it can be dropped once that parent has
  // run. Without this the whole DP is held in memory at once, which on a 900-node
  // graph is thousands of live Maps for no reason.
  const consumers = new Int32Array(nodes.length);
  for (const n of nodes) {
    if (n.type === JOIN) { consumers[n.a]++; consumers[n.b]++; }
    else if (n.child !== undefined) consumers[n.child]++;
  }
  const release = (i) => { if (--consumers[i] <= 0) cost[i] = null; };

  let ticks = 0;
  const overdue = () => (++ticks & 255) === 0 && Date.now() > deadlineMs;

  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    const bag = n.bag, m = bag.length;
    const cur = new Map(), bp = new Map();
    const put = (code, c, info) => {
      const old = cur.get(code);
      if (old === undefined || c < old) { cur.set(code, c); bp.set(code, info); }
    };

    if (n.type === LEAF) {
      put(0, 0, null);
    } else if (n.type === INTRO_V) {
      // Positions shift because the bag is kept sorted; map child slots to ours.
      const cbag = nodes[n.child].bag;
      const slot = cbag.map((x) => bag.indexOf(x));
      const at = bag.indexOf(n.v);
      for (const [code, c] of cost[n.child]) {
        decodeLabels(code, cbag.length, base, la);
        lb.fill(0, 0, m);
        let maxBlock = 0;
        for (let i = 0; i < cbag.length; i++) { lb[slot[i]] = la[i]; if (la[i] > maxBlock) maxBlock = la[i]; }
        // the new node can sit this one out...
        lb[at] = 0;
        put(encodeLabels(lb, m, base), c, { child: code });
        // ...or join as a component of its own, to be linked up by later edges
        lb[at] = maxBlock + 1;
        canonicalize(lb, m);
        put(encodeLabels(lb, m, base), c, { child: code });
      }
      release(n.child);
    } else if (n.type === FORGET_V) {
      const cbag = nodes[n.child].bag;
      const at = cbag.indexOf(n.v);
      const slot = cbag.map((x) => bag.indexOf(x)); // -1 for the forgotten one
      const isTerm = terminalMask[n.v];
      for (const [code, c] of cost[n.child]) {
        decodeLabels(code, cbag.length, base, la);
        const mine = la[at];
        if (mine === 0) {
          // Leaving for good without ever being used — fine, unless it was picked.
          if (isTerm) continue;
        } else {
          // Its component would be sealed off here. Only the one containing the
          // atlas start is allowed to finish, and that node is never forgotten.
          let others = 0;
          for (let i = 0; i < cbag.length; i++) if (i !== at && la[i] === mine) others++;
          if (others === 0) continue;
        }
        lb.fill(0, 0, m);
        for (let i = 0; i < cbag.length; i++) if (slot[i] >= 0) lb[slot[i]] = la[i];
        canonicalize(lb, m);
        put(encodeLabels(lb, m, base), c, { child: code });
      }
      release(n.child);
    } else if (n.type === INTRO_E) {
      const ai = bag.indexOf(n.a), bi = bag.indexOf(n.b);
      const w = SCALE + (ring && ring[n.a] !== ring[n.b] ? 1 : 0);
      for (const [code, c] of cost[n.child]) {
        put(code, c, { child: code, used: false }); // edge left out
        decodeLabels(code, m, base, la);
        const x = la[ai], y = la[bi];
        // Both ends must be in the solution, and joining two nodes already in the
        // same component would close a loop, which a tree cannot have.
        if (x === 0 || y === 0 || x === y) continue;
        for (let i = 0; i < m; i++) lb[i] = la[i] === y ? x : la[i];
        canonicalize(lb, m);
        put(encodeLabels(lb, m, base), c + w, { child: code, used: true });
      }
      release(n.child);
    } else {
      // JOIN. Two branches can only be glued where they agree on which nodes are
      // in; group by that first so the pair loop stays small.
      const bucket = (table) => {
        const groups = new Map();
        for (const [code, c] of table) {
          decodeLabels(code, m, base, la);
          let mask = 0, blocks = 0;
          const lab = new Int32Array(m);
          for (let i = 0; i < m; i++) {
            lab[i] = la[i];
            if (la[i]) { mask |= 1 << i; if (la[i] > blocks) blocks = la[i]; }
          }
          let g = groups.get(mask);
          if (!g) groups.set(mask, (g = []));
          g.push({ code, c, lab, blocks });
        }
        return groups;
      };
      const groupsA = bucket(cost[n.a]);
      const groupsB = bucket(cost[n.b]);
      for (const [mask, listA] of groupsA) {
        const listB = groupsB.get(mask);
        if (!listB) continue;
        let size = 0;
        for (let i = 0; i < m; i++) if (mask & (1 << i)) size++;
        for (const A of listA) {
          for (const B of listB) {
            if (overdue()) return null;
            // Gluing two forests along shared nodes stays a forest exactly when
            // the block counts add up; otherwise the two branches meet twice and
            // close a loop. That needs exactly `A.blocks + B.blocks - size`
            // components to survive the merge, and a merge can never leave more
            // than either side started with — so most pairs die on arithmetic
            // before the union-find is touched.
            const need = A.blocks + B.blocks - size;
            if (need > A.blocks || need > B.blocks) continue;
            for (let i = 0; i < m; i++) uf[i] = i;
            firstA.fill(-1); firstB.fill(-1);
            const pa = A.lab, pb = B.lab;
            for (let i = 0; i < m; i++) {
              if (!pa[i]) continue;
              if (firstA[pa[i]] < 0) firstA[pa[i]] = i; else uf[find(i)] = find(firstA[pa[i]]);
              if (firstB[pb[i]] < 0) firstB[pb[i]] = i; else uf[find(i)] = find(firstB[pb[i]]);
            }
            let merged = 0;
            for (let i = 0; i < m; i++) if (mask & (1 << i) && find(i) === i) merged++;
            if (merged !== need) continue;
            for (let i = 0; i < m; i++) lc[i] = pa[i] ? find(i) + 1 : 0;
            canonicalize(lc, m);
            put(encodeLabels(lc, m, base), A.c + B.c, { a: A.code, b: B.code });
          }
        }
      }
      release(n.a);
      release(n.b);
    }

    cost[idx] = cur;
    back[idx] = bp;
    if (cur.size === 0) return null; // nothing survives; the picks cannot be joined
    if (overdue()) return null;
  }

  // The root bag holds only the atlas start: one node, one component.
  const answer = cost[root] && cost[root].get(1);
  if (answer === undefined || answer === null) return null;

  // Walk back down, keeping the edges that were actually taken.
  const edges = [];
  const stack = [[root, 1]];
  while (stack.length) {
    const [idx, code] = stack.pop();
    const n = nodes[idx];
    const info = back[idx].get(code);
    if (info == null) continue;
    if (n.type === JOIN) { stack.push([n.a, info.a], [n.b, info.b]); continue; }
    if (n.type === INTRO_E && info.used) edges.push([n.a, n.b]);
    stack.push([n.child, info.child]);
  }
  // The weight the DP minimised carries the tie-break penalties; the point cost
  // the atlas actually charges is just the edge count.
  if (((answer / SCALE) | 0) !== edges.length) return null; // reconstruction disagrees
  return { edges, cost: edges.length, weight: answer };
}
