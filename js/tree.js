// Parse GGG atlastree-export data.json into a render/solve-ready graph.

const ORBIT16 = [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330];

// GGG writes glossary links as [LookupKey|Display Text] (and [Term] when the key
// and the text match). The client shows only the display half — so must we.
function unlink(s) {
  return String(s).replace(/\[([^\]|]+)(?:\|([^\]]+))?\]/g, (_, key, display) => display || key);
}

// stats / reminderText / flavourText are all arrays in the export.
function lines(v) {
  return v == null ? [] : (Array.isArray(v) ? v : [v]).flat(9).map(unlink);
}

export function buildTree(raw) {
  const { skillsPerOrbit, orbitRadii } = raw.constants;
  const groups = raw.groups;
  const nodes = new Map(); // key -> node record

  // The "root" entry is a positionless pseudo-node whose single edge names the real
  // start marker; that marker is the free origin (its neighbors cost the 1st point).
  const startKey = raw.nodes.root ? String((raw.nodes.root.out || [])[0]) : null;

  const masteries = []; // wheel-center markers: not allocatable, clickable for highlight

  // group -> mechanic name (from the mastery marker each cluster carries)
  const groupCategory = new Map();
  for (const n of Object.values(raw.nodes)) {
    if (n && typeof n === "object" && n.isMastery && n.name) {
      groupCategory.set(n.group, n.name);
    }
  }

  for (const [key, n] of Object.entries(raw.nodes)) {
    if (!n || typeof n !== "object") continue;
    if (key === "root") continue;
    const g = groups[n.group];
    if (!g) continue;
    const per = skillsPerOrbit[n.orbit];
    const rad = orbitRadii[n.orbit];
    const deg = per === 16 ? ORBIT16[n.orbitIndex] : (360 * n.orbitIndex) / per;
    const a = (deg * Math.PI) / 180;
    if (n.isMastery) {
      masteries.push({
        name: unlink(n.name || ""),
        icon: n.icon || null,
        x: g.x + rad * Math.sin(a),
        y: g.y - rad * Math.cos(a),
        ringR: orbitRadii[Math.max(...(g.orbits && g.orbits.length ? g.orbits : [1]))] + 100,
      });
      continue;
    }
    const type =
      key === startKey ? "root"
      : n.isKeystone ? "keystone"
      : n.isWormhole ? "wormhole"
      : n.isNotable ? "notable"
      : "small";
    nodes.set(key, {
      id: key,
      name: unlink(n.name || "Atlas Start"),
      category: groupCategory.get(n.group) || null,
      stats: lines(n.stats),
      flavour: lines(n.flavourText),
      reminder: lines(n.reminderText),
      grantsPoints: n.grantedPassivePoints || 0,
      type,
      x: g.x + rad * Math.sin(a),
      y: g.y - rad * Math.cos(a),
      // where this node sits on its wheel — two nodes sharing a group and an
      // orbit are joined by an arc along that orbit, not a straight line
      group: n.group,
      orbit: n.orbit,
      gx: g.x,
      gy: g.y,
      radius: rad,
      angle: a,
      adj: new Set(),
    });
  }

  // Undirected adjacency: union of in/out, filtered to kept nodes.
  for (const [key, n] of Object.entries(raw.nodes)) {
    if (!nodes.has(key)) continue;
    const rec = nodes.get(key);
    for (const other of [...(n.out || []), ...(n.in || [])]) {
      const ok = nodes.get(String(other));
      if (!ok || ok === rec) continue;
      rec.adj.add(String(other));
      ok.adj.add(key);
    }
  }

  // Compact index for the solver.
  const list = [...nodes.values()];
  const indexOf = new Map(list.map((n, i) => [n.id, i]));
  const offsets = new Int32Array(list.length + 1);
  let m = 0;
  list.forEach((n, i) => { offsets[i] = m; m += n.adj.size; });
  offsets[list.length] = m;
  const neighbors = new Int32Array(m);
  let w = 0;
  for (const n of list) for (const o of n.adj) neighbors[w++] = indexOf.get(o);
  // offsets currently store starts shifted; rebuild cleanly
  let acc = 0;
  list.forEach((n, i) => { offsets[i] = acc; acc += n.adj.size; });
  offsets[list.length] = acc;

  return {
    nodes,
    list,
    masteries,
    indexOf,
    csr: { offsets, neighbors },
    rootIndex: indexOf.get(startKey),
    bounds: { minX: raw.min_x, minY: raw.min_y, maxX: raw.max_x, maxY: raw.max_y },
    totalPoints: raw.points.totalPoints,
  };
}
