import { buildTree } from "./tree.js";
import { CATEGORY_COLOR, nodeColor, categoryColor } from "./palette.js";

const canvas = document.getElementById("tree");
const ctx = canvas.getContext("2d");
const tooltip = document.getElementById("tooltip");
const ptsEl = document.getElementById("points");
const statusEl = document.getElementById("status");
const toastEl = document.getElementById("toast");
const panelEl = document.getElementById("panel");
const panelBody = document.getElementById("panel-body");
const bonusBtn = document.getElementById("bonuses");

let T = null;
let view = { s: 0.1, x: 0, y: 0 };
let hover = null;          // node record
let hoverMastery = null;
const picked = new Set();  // node ids
const blockedIds = new Set();
let highlightName = null;  // mastery cluster highlight
let stale = false;         // picks/blocks changed since last solve
let result = { nodes: new Set(), points: 0, optimal: null, unreachable: new Set() };
let worker = null;
let solveSeq = 0;
let edges = [];            // {a, b, gate} precomputed once

// Node fills come from palette.js (mechanic + rank); these are the states that
// override it, plus the chrome.
const COLORS = {
  bg: "#12161c",
  edge: "#2b333e",
  edgePath: "#3fd0c9",
  wormhole: "#9a7fd0",
  picked: "#ffd76b",
  path: "#3fd0c9",
  blocked: "#8a3232",
  unreachable: "#d05a5a",
  hover: "#ffffff",
  label: "#aab4c0",
  mastery: "#242b34",
  masteryLine: "#3a444f",
  highlight: "#ffd76b",
};
const RADII = { root: 90, keystone: 70, notable: 52, wormhole: 55, small: 32 };

// ---------------------------------------------------------------- boot

let masteryCoords = null;      // icon path -> {x,y,w,h} in the sprite sheet
const masteryImg = new Image();
masteryImg.onload = () => draw();
masteryImg.src = "img/mastery.png";

fetch("data/atlas.json")
  .then((r) => r.json())
  .then((raw) => {
    T = buildTree(raw);
    masteryCoords = raw.sprites?.mastery?.["0.5"]?.coords || null;
    for (const n of T.list) {
      for (const o of n.adj) {
        if (o < n.id) continue;
        const b = T.nodes.get(o);
        edges.push({ a: n, b, arc: arcBetween(n, b), gate: n.type === "wormhole" && b.type === "wormhole" });
      }
    }
    initWorker();
    fitView();
    readHash();
    buildPickGrid();
    buildKey();
    if (picked.size) solveNow();
    draw();
    updateHud();
  });

function initWorker() {
  // A module worker: the solver imports its exact phase from steiner-exact.js.
  worker = new Worker("js/solver.js", { type: "module" });
  // Which ring each node sits on, as one comparable number. Equal keys mean the
  // two nodes are on the same wheel and the same orbit — the solver uses that to
  // break ties towards routes that follow a ring instead of cutting across one.
  const ring = new Int32Array(T.list.length);
  T.list.forEach((n, i) => { ring[i] = n.group * 8 + n.orbit; });
  worker.postMessage({
    kind: "init",
    n: T.list.length,
    offsets: T.csr.offsets,
    neighbors: T.csr.neighbors,
    ring,
    root: T.rootIndex,
  });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.seq !== solveSeq) return;
    result = {
      nodes: new Set(m.nodes.map((i) => T.list[i].id)),
      points: m.points,
      optimal: m.optimal,
      unreachable: new Set(m.unreachable.map((i) => T.list[i].id)),
    };
    updateHud();
    renderBonuses();
    draw();
  };
}

function solveNow() {
  solveSeq++;
  stale = false;
  worker.postMessage({
    kind: "solve",
    seq: solveSeq,
    picks: [...picked].map((id) => T.indexOf.get(id)),
    blocked: [...blockedIds].map((id) => T.indexOf.get(id)),
  });
  if (picked.size) statusEl.textContent = "computing…";
}

function markStale() {
  stale = true;
  updateHud();
}

function updateHud() {
  writeHash();
  if (stale) {
    ptsEl.textContent = `${picked.size} pick${picked.size === 1 ? "" : "s"}`;
    ptsEl.classList.remove("over");
    statusEl.textContent = picked.size ? "press Find Path" : "click nodes to pick · right-click to block";
    statusEl.className = "";
    return;
  }
  const extra = [...result.nodes].reduce((a, id) => a + (T.nodes.get(id)?.grantsPoints || 0), 0);
  const budget = T.totalPoints + extra;
  ptsEl.textContent = `${result.points} / ${budget} pts`;
  ptsEl.classList.toggle("over", result.points > budget);
  if (result.unreachable.size) {
    statusEl.textContent = `${result.unreachable.size} pick(s) unreachable — blocked off`;
    statusEl.className = "bad";
  } else if (picked.size === 0) {
    statusEl.textContent = "click nodes to pick · right-click to block";
    statusEl.className = "";
  } else {
    statusEl.textContent = result.optimal === true ? "✓ optimal" :
      result.optimal === null ? "computing exact…" : "best found (heuristic)";
    statusEl.className = result.optimal === true ? "good" : "";
  }
}

// ---------------------------------------------------------------- bonuses panel

function renderBonuses() {
  const lines = aggregateStats(result.nodes);
  bonusBtn.textContent = `Bonuses (${lines.length})`;
  panelBody.innerHTML = lines.length
    ? lines.map((l) => `<div class="stat">${esc(l)}</div>`).join("")
    : `<div class="stat dim">No path computed — pick nodes and press Find Path.</div>`;
}

function aggregateStats(ids) {
  const agg = new Map();
  for (const id of ids) {
    const n = T.nodes.get(id);
    if (!n) continue;
    for (const line of n.stats) {
      if (/^Connects to /.test(line)) continue; // gateway plumbing, not a bonus
      const nums = [];
      const template = line.replace(/(\d+(?:\.\d+)?)/g, (m) => { nums.push(parseFloat(m)); return "\u0000"; });
      const e = agg.get(template);
      if (!e) agg.set(template, { template, sums: nums, count: 1 });
      else {
        e.count++;
        for (let i = 0; i < e.sums.length && i < nums.length; i++) e.sums[i] += nums[i];
      }
    }
  }
  const out = [];
  for (const e of agg.values()) {
    let i = 0;
    let text = e.template.replace(/\u0000/g, () => fmtNum(e.sums[i++]));
    if (e.sums.length === 0 && e.count > 1) text += `  (×${e.count})`;
    out.push(text);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function fmtNum(v) {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

bonusBtn.onclick = () => {
  panelEl.classList.toggle("hidden");
};

// ---------------------------------------------------------------- mechanics index

const keyEl = document.getElementById("key");
const keyBtn = document.getElementById("mechanics");

function buildKey() {
  const counts = new Map();
  for (const n of T.list) if (n.category) counts.set(n.category, (counts.get(n.category) || 0) + 1);
  keyEl.innerHTML =
    `<h2>Mechanics</h2>` +
    Object.keys(CATEGORY_COLOR).sort().map((name) => {
      const c = counts.get(name) || 0;
      return `<div class="key-row" data-name="${esc(name)}">` +
        `<i class="key-sw" style="background:${categoryColor(name)}"></i>` +
        `<span class="key-name">${esc(name)}</span><span class="key-n">${c}</span></div>`;
    }).join("");
  keyEl.querySelectorAll(".key-row").forEach((row) => {
    row.onclick = () => {
      const name = row.dataset.name;
      highlightName = highlightName === name ? null : name;
      syncKeySelection();
      draw();
    };
  });
}

function syncKeySelection() {
  keyEl.querySelectorAll(".key-row").forEach((row) => {
    row.classList.toggle("on", row.dataset.name === highlightName);
  });
}

keyBtn.onclick = () => {
  keyEl.classList.toggle("hidden");
};

// ---------------------------------------------------------------- view/draw

function fitView() {
  const { minX, minY, maxX, maxY } = T.bounds;
  const pad = 300;
  const sx = canvas.clientWidth / (maxX - minX + pad * 2);
  const sy = canvas.clientHeight / (maxY - minY + pad * 2);
  view.s = Math.min(sx, sy);
  view.x = canvas.clientWidth / 2 - view.s * (minX + maxX) / 2;
  view.y = canvas.clientHeight / 2 - view.s * (minY + maxY) / 2;
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  draw();
}
window.addEventListener("resize", resize);

// Two nodes on the same wheel and the same orbit are joined by an arc running
// along that orbit — that is where the tree's curved links come from. Anything
// else (across wheels, or hopping orbits) is a straight line.
//
// Node angles are measured from straight up, canvas angles from the +x axis,
// hence the quarter-turn. The arc takes the short way round; a link spanning
// more than a third of the wheel is drawn straight instead, because sweeping
// most of the way around a wheel reads as a circle rather than a connection.
const MAX_ARC = (2 * Math.PI) / 3;

function arcBetween(a, b) {
  if (a.group !== b.group || a.orbit !== b.orbit || !a.radius) return null;
  let d = b.angle - a.angle;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  if (!d || Math.abs(d) > MAX_ARC) return null;
  const from = a.angle - Math.PI / 2;
  return { cx: a.gx, cy: a.gy, r: a.radius, from, to: from + d, ccw: d < 0 };
}

// Adds one edge to the current path. arc() would draw a line from the current
// point to the arc's start, so we moveTo that start first — it is exactly a.x/a.y.
function traceEdge(e) {
  ctx.moveTo(e.a.x, e.a.y);
  if (e.arc) ctx.arc(e.arc.cx, e.arc.cy, e.arc.r, e.arc.from, e.arc.to, e.arc.ccw);
  else ctx.lineTo(e.b.x, e.b.y);
}

function draw() {
  if (!T) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.x, dpr * view.y);

  const inPath = (id) => !stale && result.nodes.has(id);

  // base edges (gateway links hidden unless hovered)
  ctx.lineWidth = 8;
  ctx.strokeStyle = COLORS.edge;
  ctx.beginPath();
  for (const e of edges) {
    if (e.gate) continue;
    traceEdge(e);
  }
  ctx.stroke();

  // path edges
  ctx.lineWidth = 16;
  ctx.strokeStyle = COLORS.edgePath;
  ctx.beginPath();
  for (const e of edges) {
    if (e.gate || !inPath(e.a.id) || !inPath(e.b.id)) continue;
    traceEdge(e);
  }
  ctx.stroke();

  // gateway links used by the path: subtle dashed hint
  ctx.setLineDash([50, 40]);
  ctx.lineWidth = 10;
  ctx.strokeStyle = "rgba(63, 208, 201, 0.35)";
  ctx.beginPath();
  for (const e of edges) {
    if (!e.gate || !inPath(e.a.id) || !inPath(e.b.id)) continue;
    ctx.moveTo(e.a.x, e.a.y);
    ctx.lineTo(e.b.x, e.b.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // hovered gateway: show where it leads
  if (hover && hover.type === "wormhole") {
    ctx.lineWidth = 14;
    ctx.strokeStyle = COLORS.wormhole;
    ctx.beginPath();
    for (const o of hover.adj) {
      const b = T.nodes.get(o);
      if (b.type !== "wormhole") continue;
      ctx.moveTo(hover.x, hover.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(b.x, b.y, RADII.wormhole + 26, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
    }
    ctx.stroke();
  }

  // mastery cluster highlight rings (under nodes), in that mechanic's colour
  if (highlightName !== null) {
    const hc = categoryColor(highlightName);
    ctx.lineWidth = 14;
    ctx.strokeStyle = hc;
    for (const m of T.masteries) {
      if (m.name !== highlightName) continue;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.ringR, 0, Math.PI * 2);
      ctx.globalAlpha = 0.85;
      ctx.stroke();
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = hc;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // mastery wheel-center markers: real mechanic icons, kept legible at any zoom
  const mSize = masterySize();
  for (const m of T.masteries) {
    const c = masteryCoords && m.icon ? masteryCoords[m.icon] : null;
    if (c && masteryImg.complete && masteryImg.naturalWidth) {
      ctx.drawImage(masteryImg, c.x, c.y, c.w, c.h, m.x - mSize / 2, m.y - mSize / 2, mSize, mSize);
    } else {
      ctx.beginPath();
      ctx.arc(m.x, m.y, mSize / 2.6, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.mastery;
      ctx.fill();
    }
    // Thin ring tying the icon to the nodes around it. It takes the muted fill
    // rather than the identity colour — there is one of these on every wheel, so
    // at full chroma a hundred of them out-shout the actual selection.
    ctx.beginPath();
    ctx.arc(m.x, m.y, mSize / 2 + 6, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(5, 2 / view.s);
    ctx.strokeStyle = nodeColor(m.name, "keystone");
    ctx.stroke();
    if (m.name === highlightName || m === hoverMastery) {
      ctx.beginPath();
      ctx.arc(m.x, m.y, mSize / 2 + 14, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(8, 3 / view.s);
      ctx.strokeStyle = m.name === highlightName ? COLORS.highlight : COLORS.hover;
      ctx.stroke();
    }
  }

  // nodes
  for (const n of T.list) {
    const r = RADII[n.type];
    let fill = nodeColor(n.category, n.type);
    if (inPath(n.id)) fill = COLORS.path;
    if (picked.has(n.id)) fill = COLORS.picked;
    if (!stale && result.unreachable.has(n.id)) fill = COLORS.unreachable;
    if (blockedIds.has(n.id)) fill = COLORS.blocked;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (n.type === "keystone" || n.type === "wormhole") {
      ctx.lineWidth = 6;
      ctx.strokeStyle = "#12161c";
      ctx.stroke();
    }
    if (blockedIds.has(n.id)) {
      ctx.lineWidth = 12;
      ctx.strokeStyle = "#e0b0b0";
      const d = r * 0.62;
      ctx.beginPath();
      ctx.moveTo(n.x - d, n.y - d); ctx.lineTo(n.x + d, n.y + d);
      ctx.moveTo(n.x - d, n.y + d); ctx.lineTo(n.x + d, n.y - d);
      ctx.stroke();
    }
    if (hover === n) {
      ctx.lineWidth = 8;
      ctx.strokeStyle = COLORS.hover;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 20, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // picked markers on top: glow + ring with a minimum on-screen size so
  // selections stay obvious even fully zoomed out
  const minR = 16 / view.s;
  for (const id of picked) {
    const n = T.nodes.get(id);
    const r = Math.max(RADII[n.type] + 16, minR);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 215, 107, 0.10)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(n.x, n.y, r * 1.45, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 215, 107, 0.18)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(10, 4 / view.s);
    ctx.strokeStyle = "#ffe9a8";
    ctx.stroke();
  }

  if (view.s > 0.22) drawLabels();
}

// Labels are laid out in screen space, not world space: a fixed on-screen size
// stays legible at every zoom, and it lets us reject a label that would land on
// one already drawn. Each candidate tries eight positions around its node and is
// dropped only if all eight collide — high-priority names claim their spot first,
// so a pick or a keystone never loses its label to a neighbouring notable.
const LABEL_FONT = "600 13px 'Chakra Petch', sans-serif";
const MASTERY_FONT = "600 12px 'Chakra Petch', sans-serif";
const widthCache = new Map();
let lastLabels = [];   // rects drawn last frame, for the overlap test

function textWidth(s, font) {
  const k = font + "\u0000" + s;
  let w = widthCache.get(k);
  if (w === undefined) { ctx.font = font; w = ctx.measureText(s).width; widthCache.set(k, w); }
  return w;
}

// A wheel's notables sit ~100px apart on screen, but "Secret Compartments" is
// ~140px wide on one line. Wrapping long names at whichever break balances the
// two halves is what lets a cluster keep all its labels instead of all but one
// being dropped for overlapping.
const WRAP_AT = 92;
const LINE_H = 14;
const layoutCache = new Map();

function layoutText(text, font) {
  const k = font + "|" + text;
  let l = layoutCache.get(k);
  if (l) return l;
  const words = text.split(" ");
  const w1 = textWidth(text, font);
  if (w1 <= WRAP_AT || words.length < 2) {
    l = { lines: [text], w: w1 };
  } else {
    l = null;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(" "), b = words.slice(i).join(" ");
      const w = Math.max(textWidth(a, font), textWidth(b, font));
      if (!l || w < l.w) l = { lines: [a, b], w };
    }
  }
  layoutCache.set(k, l);
  return l;
}

function drawLabels() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const placed = lastLabels = [];
  const PAD = 3;  // breathing room between neighbours

  const free = (r) => {
    if (r.x0 < 2 || r.x1 > W - 2 || r.y0 < 2 || r.y1 > H - 2) return false;
    for (const p of placed) if (r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0) return false;
    return true;
  };

  // Build the candidate list, most important first.
  const inPath = (id) => !stale && result.nodes.has(id);
  const cands = [];
  for (const n of T.list) {
    if (n.type === "small" || n.type === "root") continue;
    const rank =
      hover === n ? 0
      : picked.has(n.id) ? 1
      : inPath(n.id) ? 2
      : n.type === "keystone" ? 3
      : n.type === "wormhole" ? 5
      : 6;
    cands.push({ rank, text: n.name, font: LABEL_FONT, r: RADII[n.type] * view.s,
                 sx: n.x * view.s + view.x, sy: n.y * view.s + view.y,
                 color: picked.has(n.id) ? "#ffe9a8" : inPath(n.id) ? COLORS.path : COLORS.label });
  }
  for (const m of T.masteries) {
    if (!m.name) continue;
    cands.push({ rank: m.name === highlightName ? 2.5 : 4, text: m.name, font: MASTERY_FONT,
                 r: masterySize() * view.s / 2,
                 sx: m.x * view.s + view.x, sy: m.y * view.s + view.y,
                 color: m.name === highlightName ? categoryColor(m.name) : "#7d8894" });
  }
  cands.sort((a, b) => a.rank - b.rank);

  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(18, 22, 28, 0.92)"; // halo so text survives crossing a line
  for (const c of cands) {
    // cheap viewport reject before measuring
    if (c.sx < -200 || c.sx > W + 200 || c.sy < -80 || c.sy > H + 80) continue;
    const lay = layoutText(c.text, c.font);
    const half = lay.w / 2 + PAD;
    const h2 = (lay.lines.length * LINE_H) / 2 + PAD;
    const gap = c.r + 8;
    // below / above first (a name reads best under its node), then the sides,
    // then the diagonals — a ring of eight beats dropping the label entirely.
    const d = 0.72; // diagonal offsets, ~cos(45°)
    const spots = [
      [c.sx, c.sy + gap + h2],
      [c.sx, c.sy - gap - h2],
      [c.sx + gap + half, c.sy],
      [c.sx - gap - half, c.sy],
      [c.sx + (gap + half) * d, c.sy + (gap + h2) * d],
      [c.sx - (gap + half) * d, c.sy + (gap + h2) * d],
      [c.sx + (gap + half) * d, c.sy - (gap + h2) * d],
      [c.sx - (gap + half) * d, c.sy - (gap + h2) * d],
    ];
    for (const [cx, cy] of spots) {
      const rect = { x0: cx - half, x1: cx + half, y0: cy - h2, y1: cy + h2 };
      if (!free(rect)) continue;
      rect.text = c.text;
      placed.push(rect);
      ctx.font = c.font;
      ctx.fillStyle = c.color;
      const top = cy - ((lay.lines.length - 1) * LINE_H) / 2;
      lay.lines.forEach((ln, i) => {
        ctx.strokeText(ln, cx, top + i * LINE_H);
        ctx.fillText(ln, cx, top + i * LINE_H);
      });
      break;
    }
  }
}

// ---------------------------------------------------------------- picking

let grid = null;
const CELL = 400;
function buildPickGrid() {
  grid = new Map();
  for (const n of T.list) {
    const k = `${Math.floor(n.x / CELL)},${Math.floor(n.y / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(n);
  }
}

function canvasXY(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function toWorld(px, py) {
  return [(px - view.x) / view.s, (py - view.y) / view.s];
}

function nodeAt(px, py) {
  const [wx, wy] = toWorld(px, py);
  const cx = Math.floor(wx / CELL), cy = Math.floor(wy / CELL);
  let bestN = null, bestD = Infinity;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const cell = grid.get(`${cx + dx},${cy + dy}`);
    if (!cell) continue;
    for (const n of cell) {
      const d = Math.hypot(n.x - wx, n.y - wy);
      if (d < RADII[n.type] + 18 && d < bestD) { bestD = d; bestN = n; }
    }
  }
  return bestN;
}

function masterySize() {
  // world-units icon size with a ~32px on-screen floor for at-a-glance reading
  return Math.max(150, 32 / view.s);
}

function masteryAt(px, py) {
  const [wx, wy] = toWorld(px, py);
  const hitR = masterySize() / 2 + 10;
  let best = null, bestD = Infinity;
  for (const m of T.masteries) {
    const d = Math.hypot(m.x - wx, m.y - wy);
    if (d < hitR && d < bestD) { bestD = d; best = m; }
  }
  return best;
}

// ---------------------------------------------------------------- input

let dragging = false, moved = false, lastX = 0, lastY = 0;

canvas.addEventListener("pointerdown", (e) => {
  dragging = true; moved = false;
  lastX = e.clientX; lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  if (dragging) {
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (Math.hypot(dx, dy) > 3 || moved) {
      moved = true;
      view.x += dx; view.y += dy;
      lastX = e.clientX; lastY = e.clientY;
      draw();
    }
    return;
  }
  const [px, py] = canvasXY(e);
  const n = nodeAt(px, py);
  const m = n ? null : masteryAt(px, py);
  if (n !== hover || m !== hoverMastery) { hover = n; hoverMastery = m; draw(); }
  if (n) showTooltip(n, e.clientX, e.clientY);
  else if (m && m.name) showMasteryTooltip(m, e.clientX, e.clientY);
  else tooltip.style.display = "none";
});

canvas.addEventListener("pointerup", (e) => {
  dragging = false;
  if (moved) return;
  const [px, py] = canvasXY(e);
  const n = nodeAt(px, py);
  if (n) {
    if (e.button !== 0 || n.type === "root") return;
    if (blockedIds.has(n.id)) { toast("unblock it first (right-click)"); return; }
    if (picked.has(n.id)) picked.delete(n.id);
    else picked.add(n.id);
    markStale(); draw();
    return;
  }
  const m = masteryAt(px, py);
  if (m && m.name) {
    highlightName = highlightName === m.name ? null : m.name;
    syncKeySelection();
    draw();
  }
});

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const n = nodeAt(...canvasXY(e));
  if (!n || n.type === "root") return;
  if (blockedIds.has(n.id)) blockedIds.delete(n.id);
  else { blockedIds.add(n.id); picked.delete(n.id); }
  markStale(); draw();
});

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const [cx, cy] = canvasXY(e);
  const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const ns = Math.min(3, Math.max(0.02, view.s * f));
  const k = ns / view.s;
  view.x = cx - k * (cx - view.x);
  view.y = cy - k * (cy - view.y);
  view.s = ns;
  draw();
}, { passive: false });

function showTooltip(n, px, py) {
  const lines = [`<b>${esc(n.name)}</b>`];
  if (n.category) {
    lines.push(`<span class="tt-cat" style="color:${categoryColor(n.category)}">${esc(n.category)}</span>`);
  }
  for (const s of n.stats) lines.push(esc(s));
  for (const s of n.reminder) lines.push(`<i>${esc(s)}</i>`);
  for (const s of n.flavour) lines.push(`<span class="tt-flavour">${esc(s)}</span>`);
  if (n.type === "wormhole") lines.push(`<i>gateway — connects to its twin</i>`);
  if (blockedIds.has(n.id)) lines.push(`<span class="tt-blocked">BLOCKED — right-click to unblock</span>`);
  placeTooltip(lines.join("<br>"), px, py);
}

function showMasteryTooltip(m, px, py) {
  placeTooltip(`<b>${esc(m.name)}</b><br><i>click to highlight all ${esc(m.name)} clusters</i>`, px, py);
}

function placeTooltip(html, px, py) {
  tooltip.innerHTML = html;
  tooltip.style.display = "block";
  const pad = 14;
  let x = px + pad, y = py + pad;
  if (x + tooltip.offsetWidth > innerWidth) x = px - tooltip.offsetWidth - pad;
  if (y + tooltip.offsetHeight > innerHeight) y = py - tooltip.offsetHeight - pad;
  tooltip.style.left = x + "px";
  tooltip.style.top = y + "px";
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
}

// ---------------------------------------------------------------- buttons, hash, toast

document.getElementById("solve").onclick = () => solveNow();
document.getElementById("clear-picks").onclick = () => {
  picked.clear(); markStale(); draw();
};
document.getElementById("clear-blocks").onclick = () => {
  blockedIds.clear(); markStale(); draw();
};
document.getElementById("share").onclick = () => {
  navigator.clipboard.writeText(location.href).then(() => toast("link copied"));
};
document.getElementById("fit").onclick = () => { fitView(); draw(); };

function writeHash() {
  const s = [...picked].join(".");
  const b = [...blockedIds].join(".");
  history.replaceState(null, "", `#s=${s}&b=${b}`);
}
function readHash() {
  const m = location.hash.match(/s=([^&]*)/);
  const mb = location.hash.match(/b=([^&]*)/);
  if (m && m[1]) for (const id of m[1].split(".")) if (T.nodes.has(id)) picked.add(id);
  if (mb && mb[1]) for (const id of mb[1].split(".")) if (T.nodes.has(id)) blockedIds.add(id);
}

let toastTimer = 0;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
}

resize();

// debug/testing handle
window.__atlas = {
  get T() { return T; }, view, picked, blockedIds,
  get result() { return result; },
  get stale() { return stale; },
  get highlightName() { return highlightName; },
  get labels() { return lastLabels; },
  screenPos(id) {
    const n = T.nodes.get(String(id));
    if (!n) return null;
    const r = canvas.getBoundingClientRect();
    return { x: n.x * view.s + view.x + r.left, y: n.y * view.s + view.y + r.top };
  },
  masteryScreenPos(name) {
    const m = T.masteries.find((mm) => mm.name === name);
    if (!m) return null;
    const r = canvas.getBoundingClientRect();
    return { x: m.x * view.s + view.x + r.left, y: m.y * view.s + view.y + r.top };
  },
};
