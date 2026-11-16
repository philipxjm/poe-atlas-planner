import { buildTree } from "./tree.js";
import { CATEGORY_COLOR, nodeColor, categoryColor } from "./palette.js";
import { PRESETS, presetNodes } from "./presets.js";
import { parseQuery, scoreFields, MISS } from "./fuzzy.js";
import { buildHash, parseHash } from "./share.js";

const canvas = document.getElementById("tree");
const ctx = canvas.getContext("2d");
const tooltip = document.getElementById("tooltip");
const ptsEl = document.getElementById("points");
const statusEl = document.getElementById("status");
const toastEl = document.getElementById("toast");
const panelEl = document.getElementById("panel");
const panelBody = document.getElementById("panel-body");
const bonusBtn = document.getElementById("bonuses");
const searchEl = document.getElementById("search");
const searchNEl = document.getElementById("search-n");

// A phone has no hover and no right button: a tap picks and shows the node's
// card, a long press blocks. Decided per pointer, so a touch laptop gets both.
const coarse = matchMedia("(pointer: coarse)");
let lastPointer = coarse.matches ? "touch" : "mouse";
const touchUI = () => lastPointer !== "mouse";
const narrow = () => innerWidth <= 640;

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
let searchTerms = null;    // parsed query, or null when the box is empty
let searchHits = [];       // matching node ids, best score first
const searchSet = new Set();
let searchAt = -1;         // index into searchHits while cycling with Enter

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
  // Search has to be legible on top of every other state, so it takes the one hue
  // nothing else uses. Gold is picked, teal is the path, red is blocked.
  search: "#ff6ad5",
  searchRGB: "255, 106, 213",
};
const RADII = { root: 90, keystone: 70, notable: 52, wormhole: 55, small: 32 };

// ---------------------------------------------------------------- boot

let masteryCoords = null;      // icon path -> {x,y,w,h} in the sprite sheet
const masteryImg = new Image();
masteryImg.onload = () => draw();
masteryImg.src = "img/mastery.webp";

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
    buildHaystacks();
    if (searchEl.value) runSearch(searchEl.value); // survives a reload with text in the box
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
  syncKeyPicks();
}

function updateHud() {
  writeHash();
  if (stale) {
    ptsEl.textContent = `${picked.size} pick${picked.size === 1 ? "" : "s"}`;
    ptsEl.classList.remove("over");
    statusEl.textContent = picked.size ? "press Find Path" : `${touchUI() ? "tap" : "click"} nodes to pick`;
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
    statusEl.textContent = `${touchUI() ? "tap" : "click"} nodes to pick`;
    statusEl.className = "";
  } else {
    statusEl.textContent = result.optimal === true ? "✓ optimal" :
      result.optimal === null ? "computing exact…" : "best found (heuristic)";
    statusEl.className = result.optimal === true ? "good" : "";
  }
}

// ---------------------------------------------------------------- search

// One lowercase haystack per node, built once. A node matches if every term in
// the query hits one of these — not necessarily the same one, which is what lets
// "breach pack" find a Breach node whose stat line mentions pack size.
const haystacks = new Map();

function buildHaystacks() {
  for (const n of T.list) {
    const f = [n.name.toLowerCase()];
    if (n.category) f.push(n.category.toLowerCase());
    // How people describe a node out loud, which is rarely how the data spells it.
    f.push(n.type === "wormhole" ? "gateway wormhole" : n.type);
    for (const s of n.stats) {
      if (/^Connects to /.test(s)) continue; // gateway plumbing, not a bonus
      f.push(s.toLowerCase());
    }
    for (const v of n.variants) for (const s of v.stats) f.push(s.toLowerCase());
    haystacks.set(n.id, f);
  }
}

function runSearch(q) {
  if (!T) return;
  searchTerms = parseQuery(q);
  searchSet.clear();
  searchHits = [];
  searchAt = -1;
  if (searchTerms) {
    const scored = [];
    for (const n of T.list) {
      const s = scoreFields(searchTerms, haystacks.get(n.id));
      if (s !== MISS) scored.push([s, n.id]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    for (const [, id] of scored) { searchHits.push(id); searchSet.add(id); }
  }
  updateSearchHud();
  renderBonuses();
  pulseLoop();
  draw();
}

function updateSearchHud() {
  if (!searchTerms) { searchNEl.textContent = ""; searchNEl.className = ""; return; }
  if (!searchHits.length) { searchNEl.textContent = "none"; searchNEl.className = "none"; return; }
  searchNEl.textContent = searchAt >= 0 ? `${searchAt + 1}/${searchHits.length}` : `${searchHits.length}`;
  searchNEl.className = "";
}

// Enter walks the matches best-first, centring each one. Matches are frequently
// off-screen — the atlas is far wider than any useful zoom — so a count alone
// would be telling you something you cannot go and look at.
function gotoMatch(step) {
  if (!searchHits.length) return;
  const len = searchHits.length;
  // -1 means "nowhere yet", which is a position before the first match rather than
  // one of them: stepping forward from it lands on the first, back on the last.
  searchAt = searchAt < 0 ? (step > 0 ? 0 : len - 1) : (searchAt + step + len) % len;
  const n = T.nodes.get(searchHits[searchAt]);
  const s = Math.max(view.s, 0.4);
  view.x = canvas.clientWidth / 2 - n.x * s;
  view.y = canvas.clientHeight / 2 - n.y * s;
  view.s = s;
  updateSearchHud();
  draw();
  if (touchUI()) showTooltip(n);
}

// The match rings breathe, which is what makes them findable when the query lights
// up a node on the far side of the atlas. Only runs while a search is live, and at
// half frame rate — the pulse reads the same and a full redraw is not free.
let pulseRAF = 0;
let pulseLast = 0;
function pulseLoop() {
  if (searchSet.size && !pulseRAF) {
    const tick = (ts) => {
      pulseRAF = requestAnimationFrame(tick);
      if (ts - pulseLast < 33) return;
      pulseLast = ts;
      draw();
    };
    pulseRAF = requestAnimationFrame(tick);
  } else if (!searchSet.size && pulseRAF) {
    cancelAnimationFrame(pulseRAF);
    pulseRAF = 0;
  }
}

function pulse() {
  return 0.5 + 0.5 * Math.sin(performance.now() / 420);
}

searchEl.addEventListener("input", () => runSearch(searchEl.value));
// the counter doubles as "next match", which is all a phone has instead of Enter
searchNEl.addEventListener("click", () => gotoMatch(1));
searchEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    gotoMatch(e.shiftKey ? -1 : 1);
    // a phone keyboard covers half the tree; the counter steps on from here
    if (coarse.matches) searchEl.blur();
  }
  else if (e.key === "Escape") { searchEl.value = ""; runSearch(""); searchEl.blur(); }
});

// The tree is a canvas, so the browser's own find is useless here — taking Ctrl+F
// costs nothing and is what anyone will reach for first.
window.addEventListener("keydown", (e) => {
  if (e.target === searchEl) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.key === "/" || ((e.ctrlKey || e.metaKey) && e.key === "f")) {
    e.preventDefault();
    searchEl.focus();
    searchEl.select();
  }
});

// ---------------------------------------------------------------- bonuses panel

function renderBonuses() {
  const lines = aggregateStats(result.nodes);
  const choices = choiceNodes(result.nodes);
  // The panel aggregates stats across the whole path, so its lines are summed
  // rewrites of the node text and have to be matched in their own right. Here a
  // line is a hit only if the whole query lands in that one line.
  let hits = 0;
  const html = lines.map((l) => {
    const hit = searchTerms && scoreFields(searchTerms, [l.toLowerCase()]) !== MISS;
    if (hit) hits++;
    return `<div class="stat${hit ? " hit" : ""}">${esc(l)}</div>`;
  }).join("");
  // "Choose one" notables can't be summed: which option applies is decided in
  // game. They're listed whole, under the totals.
  const choiceHtml = choices.map((n) => {
    const opts = n.variants.map((v) => v.stats.map((s) => s.replace(/\n/g, " ")).join("; "));
    const hit = searchTerms
      && scoreFields(searchTerms, [[n.name, ...n.stats, ...opts].join(" ").toLowerCase()]) !== MISS;
    if (hit) hits++;
    return `<div class="stat choice${hit ? " hit" : ""}"><b>${esc(n.name)}</b> <i>choose one</i>`
      + n.stats.map((s) => `<br>${esc(s)}`).join("")
      + `<ul>${opts.map((o) => `<li>${esc(o)}</li>`).join("")}</ul></div>`;
  }).join("");
  const total = lines.length + choices.length;
  bonusBtn.textContent = searchTerms && total
    ? `Bonuses (${hits} of ${total})`
    : `Bonuses (${total})`;
  bonusBtn.classList.toggle("match", hits > 0);
  panelBody.innerHTML = total
    ? html + choiceHtml
    : `<div class="stat dim">No path computed — pick nodes and press Find Path.</div>`;
}

function choiceNodes(ids) {
  return [...ids].map((id) => T.nodes.get(id)).filter((n) => n && n.variants.length)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function aggregateStats(ids) {
  const agg = new Map();
  for (const id of ids) {
    const n = T.nodes.get(id);
    if (!n) continue;
    if (n.variants.length) continue; // its stat line is only a lead-in to the options
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
  // on a phone both panels are bottom sheets in the same spot
  if (narrow() && !panelEl.classList.contains("hidden")) { keyEl.classList.add("hidden"); hideTooltip(); }
};

// ---------------------------------------------------------------- mechanics index

const keyEl = document.getElementById("key");
const keyBtn = document.getElementById("mechanics");

// What each button in the panel picks: key -> { ids, label(count) }. A mechanic's
// button takes its notables, a preset's takes whatever its rule matches.
const pickSets = new Map();

function buildKey() {
  const notables = new Map();
  for (const n of T.list) {
    if (n.type !== "notable" || !n.category) continue;
    if (!notables.has(n.category)) notables.set(n.category, []);
    notables.get(n.category).push(n.id);
  }
  pickSets.clear();
  const presetRows = PRESETS.map((p, i) => {
    const ids = presetNodes(p, T.list).map((n) => n.id);
    if (!ids.length) return ""; // a patch reworded the stat its rule reads
    pickSets.set(`p${i}`, { ids, label: (c) => `${p.name}: ${c} node${c === 1 ? "" : "s"}` });
    return `<div class="key-row preset" data-set="p${i}">` +
      `<span class="key-name">${esc(p.name)}<small>${esc(p.about)}</small></span>` +
      `<button class="key-pick" data-set="p${i}"></button></div>`;
  }).join("");
  const mechanicRows = Object.keys(CATEGORY_COLOR).sort().map((name) => {
    const ids = notables.get(name) || [];
    pickSets.set(`m:${name}`, { ids, label: (c) => `${c} ${name} notable${c === 1 ? "" : "s"}` });
    return `<div class="key-row" data-name="${esc(name)}">` +
      `<i class="key-sw" style="background:${categoryColor(name)}"></i>` +
      `<span class="key-name">${esc(name)}</span>` +
      `<button class="key-pick" data-set="${esc(`m:${name}`)}"></button></div>`;
  }).join("");
  keyEl.innerHTML =
    (presetRows ? `<h2>Presets</h2>${presetRows}` : "") +
    `<h2>Mechanics</h2>` +
    `<p class="key-hint">name: highlight its wheels · button: pick all its notables</p>` +
    mechanicRows;
  keyEl.querySelectorAll(".key-row[data-name]").forEach((row) => {
    row.onclick = () => {
      const name = row.dataset.name;
      highlightName = highlightName === name ? null : name;
      syncKeySelection();
      draw();
    };
  });
  keyEl.querySelectorAll(".key-row.preset").forEach((row) => {
    row.onclick = () => togglePickSet(row.dataset.set);
  });
  keyEl.querySelectorAll(".key-pick").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation(); // the row behind it has a click of its own
      togglePickSet(btn.dataset.set);
    };
  });
  syncKeyPicks();
}

// Picks the whole set, or unpicks it if it is already all picked. Blocked nodes
// stay blocked: a block is the more deliberate of the two marks.
function togglePickSet(key) {
  const set = pickSets.get(key);
  const ids = set.ids.filter((id) => !blockedIds.has(id));
  const skipped = set.ids.length - ids.length;
  if (!ids.length) { toast("every node in that set is blocked"); return; }
  const all = ids.every((id) => picked.has(id));
  for (const id of ids) {
    if (all) picked.delete(id);
    else picked.add(id);
  }
  markStale(); draw();
  toast(`${all ? "unpicked" : "picked"} ${set.label(ids.length)}${skipped ? ` (${skipped} blocked, skipped)` : ""}`);
}

function syncKeyPicks() {
  keyEl.querySelectorAll(".key-pick").forEach((btn) => {
    const set = pickSets.get(btn.dataset.set);
    const ids = set.ids.filter((id) => !blockedIds.has(id));
    const have = ids.filter((id) => picked.has(id)).length;
    const all = ids.length > 0 && have === ids.length;
    btn.textContent = all ? `✓ ${have}` : have ? `${have}/${ids.length}` : `+ ${ids.length}`;
    btn.classList.toggle("all", all);
    btn.classList.toggle("some", have > 0 && !all);
    btn.disabled = !ids.length;
    btn.title = `${all ? "Unpick" : "Pick"} ${set.label(ids.length)}`;
  });
}

function syncKeySelection() {
  keyEl.querySelectorAll(".key-row").forEach((row) => {
    row.classList.toggle("on", row.dataset.name === highlightName);
  });
}

keyBtn.onclick = () => {
  keyEl.classList.toggle("hidden");
  if (narrow() && !keyEl.classList.contains("hidden")) { panelEl.classList.add("hidden"); hideTooltip(); }
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
  // the cards and sheets that dock at the bottom sit just above the legend,
  // and the side panels hang just below the bar
  const legend = document.getElementById("legend");
  document.documentElement.style.setProperty("--legend-h", legend.offsetHeight + "px");
  document.documentElement.style.setProperty("--bar-h", bar.offsetHeight + "px");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  draw();
}
window.addEventListener("resize", resize);
// the bar wraps onto a second row when the status text grows, which moves the
// canvas and the panels without the window changing size
const bar = document.getElementById("bar");
new ResizeObserver(resize).observe(bar);

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

  // search matches: a breathing magenta ring, under the picked markers so a node
  // that is both still reads as picked. The node keeps its own fill — search says
  // "here", it does not restate what the node is.
  if (searchSet.size) {
    const t = pulse();
    const searchMinR = 20 / view.s;
    for (const id of searchSet) {
      const n = T.nodes.get(id);
      const r = Math.max(RADII[n.type] + 22, searchMinR) * (1 + 0.10 * t);
      ctx.beginPath();
      ctx.arc(n.x, n.y, r * 1.9, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${COLORS.searchRGB}, ${(0.05 + 0.06 * t).toFixed(3)})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(9, 3.5 / view.s);
      ctx.strokeStyle = COLORS.search;
      ctx.stroke();
    }
    // the one Enter last walked to, called out from the rest of the set
    if (searchAt >= 0) {
      const n = T.nodes.get(searchHits[searchAt]);
      const r = Math.max(RADII[n.type] + 22, searchMinR) * (1 + 0.10 * t) * 1.42;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(7, 2.5 / view.s);
      ctx.strokeStyle = "#ffd0f0";
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
  // A search that matches a handful of nodes should name them even where they are
  // smalls, since that is the whole point of asking. Past that many the names stop
  // being readable anyway and would crowd out every label that was already there.
  const nameSmalls = searchSet.size > 0 && searchSet.size <= 60;
  for (const n of T.list) {
    const hit = searchSet.has(n.id);
    if (n.type === "root") continue;
    if (n.type === "small" && !(hit && nameSmalls)) continue;
    const rank =
      hover === n ? 0
      : hit ? 0.4
      : picked.has(n.id) ? 1
      : inPath(n.id) ? 2
      : n.type === "keystone" ? 3
      : n.type === "wormhole" ? 5
      : 6;
    cands.push({ rank, text: n.name, font: LABEL_FONT, r: RADII[n.type] * view.s,
                 sx: n.x * view.s + view.x, sy: n.y * view.s + view.y,
                 color: hit ? COLORS.search
                        : picked.has(n.id) ? "#ffe9a8"
                        : inPath(n.id) ? COLORS.path : COLORS.label });
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
  // (22px on a phone, where 32 would bury the whole fitted tree under icons)
  return Math.max(150, (narrow() ? 22 : 32) / view.s);
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
const pointers = new Map(); // pointerId -> {x, y}, for pinch
let pinch = null;           // {d, mx, my} of the two fingers last frame
let gesture = false;        // a pinch happened: the lift that ends it is no tap
let pressTimer = 0, pressed = false;
const LONG_PRESS = 450;

function zoomAt(cx, cy, f) {
  const ns = Math.min(3, Math.max(0.02, view.s * f));
  const k = ns / view.s;
  view.x = cx - k * (cx - view.x);
  view.y = cy - k * (cy - view.y);
  view.s = ns;
}

function pinchState() {
  const [a, b] = [...pointers.values()];
  const r = canvas.getBoundingClientRect();
  return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top };
}

function toggleBlock(n) {
  if (!n || n.type === "root") return false;
  if (blockedIds.has(n.id)) blockedIds.delete(n.id);
  else { blockedIds.add(n.id); picked.delete(n.id); }
  markStale(); draw();
  return true;
}

function hideTooltip() { tooltip.style.display = "none"; }

canvas.addEventListener("pointerdown", (e) => {
  lastPointer = e.pointerType;
  // The first finger down is the primary one: anything still in the map is a
  // finger whose lift never arrived, and would turn every later tap into a pinch.
  if (e.isPrimary) pointers.clear();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  clearTimeout(pressTimer);
  if (pointers.size === 2) {
    pinch = pinchState(); gesture = true; moved = true;
    return;
  }
  if (pointers.size > 2) return;
  dragging = true; moved = false; pressed = false; gesture = false;
  lastX = e.clientX; lastY = e.clientY;
  if (e.pointerType !== "mouse") {
    const [px, py] = canvasXY(e);
    pressTimer = setTimeout(() => {
      if (moved || pointers.size !== 1) return;
      const n = nodeAt(px, py);
      if (!toggleBlock(n)) return;
      pressed = true;
      navigator.vibrate?.(15);
      toast(blockedIds.has(n.id) ? `blocked ${n.name}` : `unblocked ${n.name}`);
      showTooltip(n);
    }, LONG_PRESS);
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size >= 2 && pinch) {
    const p = pinchState();
    view.x += p.mx - pinch.mx; view.y += p.my - pinch.my;
    if (pinch.d > 0) zoomAt(p.mx, p.my, p.d / pinch.d);
    pinch = p;
    draw();
    return;
  }
  if (dragging) {
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    // a fingertip wobbles more than a mouse, so a tap tolerates more slop
    if (Math.hypot(dx, dy) > (e.pointerType === "mouse" ? 3 : 10) || moved) {
      if (!moved) { clearTimeout(pressTimer); if (e.pointerType !== "mouse") hideTooltip(); }
      moved = true;
      view.x += dx; view.y += dy;
      lastX = e.clientX; lastY = e.clientY;
      draw();
    }
    return;
  }
  if (e.pointerType !== "mouse") return;
  const [px, py] = canvasXY(e);
  const n = nodeAt(px, py);
  const m = n ? null : masteryAt(px, py);
  if (n !== hover || m !== hoverMastery) { hover = n; hoverMastery = m; draw(); }
  if (n) showTooltip(n, e.clientX, e.clientY);
  else if (m && m.name) showMasteryTooltip(m, e.clientX, e.clientY);
  else hideTooltip();
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  clearTimeout(pressTimer);
  if (pointers.size) {
    // one finger of a pinch lifted: carry on as a drag from the one left
    pinch = null;
    const [q] = pointers.values();
    lastX = q.x; lastY = q.y;
    return false;
  }
  pinch = null;
  dragging = false;
  return !(moved || pressed || gesture);
}

canvas.addEventListener("pointercancel", endPointer);

canvas.addEventListener("pointerup", (e) => {
  if (!endPointer(e)) return;
  const touch = e.pointerType !== "mouse";
  const [px, py] = canvasXY(e);
  const n = nodeAt(px, py);
  if (n) {
    if (e.button !== 0 || n.type === "root") return;
    if (blockedIds.has(n.id)) {
      toast(`unblock it first (${touch ? "long-press" : "right-click"})`);
      if (touch) showTooltip(n);
      return;
    }
    if (picked.has(n.id)) picked.delete(n.id);
    else picked.add(n.id);
    markStale(); draw();
    // no hover on a phone: the tap is the only chance to read what was picked
    if (touch) showTooltip(n);
    return;
  }
  const m = masteryAt(px, py);
  if (m && m.name) {
    highlightName = highlightName === m.name ? null : m.name;
    syncKeySelection();
    draw();
    if (touch) showMasteryTooltip(m);
    return;
  }
  if (touch) hideTooltip();
});

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  // Android also fires this on a long press, which the timer already handled
  if (lastPointer !== "mouse") return;
  toggleBlock(nodeAt(...canvasXY(e)));
});

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const [cx, cy] = canvasXY(e);
  zoomAt(cx, cy, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  draw();
}, { passive: false });

function showTooltip(n, px, py) {
  const lines = [`<b>${esc(n.name)}</b>`];
  if (n.category) {
    lines.push(`<span class="tt-cat" style="color:${categoryColor(n.category)}">${esc(n.category)}</span>`);
  }
  for (const s of n.stats) lines.push(esc(s));
  if (n.variants.length) {
    lines.push(`<span class="tt-choose">choose one in game</span>` + n.variants.map((v) =>
      `<span class="tt-variant">${v.stats.map(variantText).join("<br>")}${
        v.reminder.map((r) => `<br><i>${variantText(r)}</i>`).join("")}</span>`).join(""));
  }
  for (const s of n.reminder) lines.push(`<i>${esc(s)}</i>`);
  for (const s of n.flavour) lines.push(`<span class="tt-flavour">${esc(s)}</span>`);
  if (n.type === "wormhole") lines.push(`<i>gateway — connects to its twin</i>`);
  if (blockedIds.has(n.id)) lines.push(`<span class="tt-blocked">BLOCKED — ${touchUI() ? "long-press" : "right-click"} to unblock</span>`);
  else if (picked.has(n.id)) lines.push(`<span class="tt-picked">PICKED</span>`);
  placeTooltip(lines.join("<br>"), px, py);
}

// GGG hard-wraps stat text for its own tooltip width; inside an indented
// option the text should wrap to ours instead.
function variantText(s) {
  return esc(s.replace(/\n/g, " "));
}

function showMasteryTooltip(m, px, py) {
  const verb = touchUI() ? "tap" : "click";
  placeTooltip(`<b>${esc(m.name)}</b><br><i>${verb} to ${highlightName === m.name && touchUI() ? "clear the highlight" : `highlight all ${esc(m.name)} clusters`}</i>`, px, py);
}

function placeTooltip(html, px, py) {
  tooltip.innerHTML = html;
  tooltip.style.display = "block";
  // Without a cursor to follow it docks as a card along the bottom, where a
  // finger isn't covering it.
  const card = px == null;
  tooltip.classList.toggle("card", card);
  if (card) {
    tooltip.style.left = tooltip.style.top = "";
    // a sheet sits in the same spot; touching the tree means you're back on it
    if (narrow()) { panelEl.classList.add("hidden"); keyEl.classList.add("hidden"); }
    return;
  }
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
// navigator.clipboard is undefined outside a secure context and can be refused
// even inside one, so neither path is a given.
function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* fall through */ }
    ta.remove();
    ok ? resolve() : reject(new Error("copy refused"));
  });
}

document.getElementById("share").onclick = () => {
  writeHash(); // the URL is already current, but a share must never copy a stale one
  const n = picked.size, b = blockedIds.size;
  const what = !n && !b ? "empty plan"
    : `${n} pick${n === 1 ? "" : "s"}${b ? `, ${b} blocked` : ""}`;
  copyText(location.href).then(
    () => toast(`link copied — ${what}`),
    () => toast("couldn't copy — the URL bar has the link"),
  );
};
document.getElementById("fit").onclick = () => { fitView(); draw(); };

function currentHash() {
  return buildHash([...picked], [...blockedIds]);
}
function writeHash() {
  const h = currentHash();
  // With nothing picked there is nothing to say, so leave the URL clean rather
  // than dirtying a fresh load with an empty fragment.
  history.replaceState(null, "", h || location.pathname + location.search);
}
function readHash() {
  const st = parseHash(location.hash);
  if (!st) return false;
  // A node the current tree has never heard of is dropped, not fatal: that is
  // what a link from an older patch looks like.
  for (const id of st.picks) if (T.nodes.has(id)) picked.add(id);
  for (const id of st.blocks) if (T.nodes.has(id)) blockedIds.add(id);
  return true;
}

// Back/forward, or a plan pasted into the address bar of a tab that already has
// one. replaceState doesn't fire this, but comparing anyway is cheaper than
// reasoning about which writes are ours.
window.addEventListener("hashchange", () => {
  if (!T || location.hash === currentHash()) return;
  picked.clear();
  blockedIds.clear();
  readHash();
  markStale();
  if (picked.size) solveNow();
  draw();
});

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
  get search() {
    return {
      terms: searchTerms,
      hits: searchHits.slice(),
      names: searchHits.map((id) => T.nodes.get(id).name),
      at: searchAt,
      animating: pulseRAF !== 0,
    };
  },
  runSearch,
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
