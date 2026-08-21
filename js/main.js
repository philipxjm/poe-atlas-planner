import { buildTree } from "./tree.js";

const canvas = document.getElementById("tree");
const ctx = canvas.getContext("2d");
const tooltip = document.getElementById("tooltip");
const ptsEl = document.getElementById("points");
const statusEl = document.getElementById("status");
const toastEl = document.getElementById("toast");

let T = null;               // parsed tree
let view = { s: 0.1, x: 0, y: 0 };
let hover = null;           // node record
const picked = new Set();   // node ids
const blockedIds = new Set();
let result = { nodes: new Set(), points: 0, optimal: null, unreachable: new Set() };
let worker = null;
let solveSeq = 0;
let solveTimer = 0;

const COLORS = {
  bg: "#12161c",
  edge: "#2b333e",
  edgePath: "#3fd0c9",
  small: "#5a6673",
  notable: "#c9a35c",
  keystone: "#7fb8a8",
  wormhole: "#9a7fd0",
  root: "#e8ded0",
  picked: "#ffd76b",
  path: "#3fd0c9",
  blocked: "#8a3232",
  unreachable: "#d05a5a",
  hover: "#ffffff",
  label: "#aab4c0",
};
const RADII = { root: 90, keystone: 70, notable: 52, wormhole: 55, small: 32 };

// ---------------------------------------------------------------- boot

fetch("data/atlas.json")
  .then((r) => r.json())
  .then((raw) => {
    T = buildTree(raw);
    initWorker();
    fitView();
    readHash();
    buildPickGrid();
    scheduleSolve();
    draw();
    statusEl.textContent = `${T.list.length} nodes · GGG export`;
  });

function initWorker() {
  worker = new Worker("js/solver.js");
  worker.postMessage({
    kind: "init",
    n: T.list.length,
    offsets: T.csr.offsets,
    neighbors: T.csr.neighbors,
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
    draw();
  };
}

function scheduleSolve() {
  clearTimeout(solveTimer);
  solveTimer = setTimeout(() => {
    solveSeq++;
    worker.postMessage({
      kind: "solve",
      seq: solveSeq,
      picks: [...picked].map((id) => T.indexOf.get(id)),
      blocked: [...blockedIds].map((id) => T.indexOf.get(id)),
    });
    if (picked.size) statusEl.textContent = "computing…";
  }, 120);
}

function updateHud() {
  const extra = [...result.nodes].reduce((a, id) => a + (T.nodes.get(id)?.grantsPoints || 0), 0);
  const budget = T.totalPoints + extra;
  ptsEl.textContent = `${result.points} / ${budget} pts`;
  ptsEl.classList.toggle("over", result.points > budget);
  if (result.unreachable.size) {
    statusEl.textContent = `${result.unreachable.size} pick(s) unreachable — blocked off`;
    statusEl.className = "bad";
  } else if (picked.size === 0) {
    statusEl.textContent = "click nodes to plan · right-click to block";
    statusEl.className = "";
  } else {
    statusEl.textContent = result.optimal === true ? "✓ optimal" :
      result.optimal === null ? "computing exact…" : "best found (heuristic)";
    statusEl.className = result.optimal === true ? "good" : "";
  }
  writeHash();
}

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

function draw() {
  if (!T) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.x, dpr * view.y);

  const inPath = (id) => result.nodes.has(id);

  // edges
  ctx.lineWidth = 8;
  ctx.strokeStyle = COLORS.edge;
  ctx.beginPath();
  for (const n of T.list) {
    for (const o of n.adj) {
      if (o < n.id) continue;
      const b = T.nodes.get(o);
      ctx.moveTo(n.x, n.y);
      ctx.lineTo(b.x, b.y);
    }
  }
  ctx.stroke();

  // path edges
  ctx.lineWidth = 16;
  ctx.strokeStyle = COLORS.edgePath;
  ctx.beginPath();
  for (const n of T.list) {
    if (!inPath(n.id)) continue;
    for (const o of n.adj) {
      if (o < n.id || !inPath(o)) continue;
      const b = T.nodes.get(o);
      ctx.moveTo(n.x, n.y);
      ctx.lineTo(b.x, b.y);
    }
  }
  ctx.stroke();

  // nodes
  for (const n of T.list) {
    const r = RADII[n.type];
    let fill = COLORS[n.type];
    if (inPath(n.id)) fill = COLORS.path;
    if (picked.has(n.id)) fill = COLORS.picked;
    if (result.unreachable.has(n.id)) fill = COLORS.unreachable;
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
    if (picked.has(n.id)) {
      ctx.lineWidth = 10;
      ctx.strokeStyle = "#fff2cc";
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 12, 0, Math.PI * 2);
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

  // labels for big nodes when zoomed in
  if (view.s > 0.28) {
    ctx.fillStyle = COLORS.label;
    ctx.font = "600 44px 'Chakra Petch', sans-serif";
    ctx.textAlign = "center";
    for (const n of T.list) {
      if (n.type === "notable" || n.type === "keystone" || n.type === "wormhole") {
        ctx.fillText(n.name, n.x, n.y + RADII[n.type] + 52);
      }
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

// Convert a pointer event's window coords to canvas-local coords.
function canvasXY(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function nodeAt(px, py) {
  const wx = (px - view.x) / view.s;
  const wy = (py - view.y) / view.s;
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
    if (Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY) > 0) {
      if (Math.hypot(dx, dy) > 3 || moved) {
        moved = true;
        view.x += dx; view.y += dy;
        lastX = e.clientX; lastY = e.clientY;
        draw();
      }
    }
    return;
  }
  const n = nodeAt(...canvasXY(e));
  if (n !== hover) { hover = n; draw(); }
  if (n) showTooltip(n, e.clientX, e.clientY);
  else tooltip.style.display = "none";
});

canvas.addEventListener("pointerup", (e) => {
  dragging = false;
  if (moved) return;
  const n = nodeAt(...canvasXY(e));
  if (!n) return;
  if (e.button === 0) {
    if (n.type === "root") return;
    if (blockedIds.has(n.id)) { toast("unblock it first (right-click)"); return; }
    if (picked.has(n.id)) picked.delete(n.id);
    else picked.add(n.id);
    scheduleSolve(); updateHud(); draw();
  }
});

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const n = nodeAt(...canvasXY(e));
  if (!n || n.type === "root") return;
  if (blockedIds.has(n.id)) blockedIds.delete(n.id);
  else { blockedIds.add(n.id); picked.delete(n.id); }
  scheduleSolve(); updateHud(); draw();
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
  for (const s of n.stats) lines.push(esc(s));
  if (n.reminder) lines.push(`<i>${esc(n.reminder)}</i>`);
  if (blockedIds.has(n.id)) lines.push(`<span class="tt-blocked">BLOCKED — right-click to unblock</span>`);
  tooltip.innerHTML = lines.join("<br>");
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

document.getElementById("clear-picks").onclick = () => {
  picked.clear(); scheduleSolve(); updateHud(); draw();
};
document.getElementById("clear-blocks").onclick = () => {
  blockedIds.clear(); scheduleSolve(); updateHud(); draw();
};
document.getElementById("share").onclick = () => {
  navigator.clipboard.writeText(location.href).then(() => toast("link copied"));
};
document.getElementById("fit").onclick = () => { fitView(); draw(); };

let hashWriting = false;
function writeHash() {
  hashWriting = true;
  const s = [...picked].join(".");
  const b = [...blockedIds].join(".");
  history.replaceState(null, "", `#s=${s}&b=${b}`);
  hashWriting = false;
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
  screenPos(id) {
    const n = T.nodes.get(String(id));
    if (!n) return null;
    const r = canvas.getBoundingClientRect();
    return { x: n.x * view.s + view.x + r.left, y: n.y * view.s + view.y + r.top };
  },
};
