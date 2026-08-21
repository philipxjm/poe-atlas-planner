# PoE Atlas Planner

Path of Exile atlas passive tree planner (3.29 data): pick the notables and keystones
you want, and it computes the minimum-point connected tree that reaches all of them.

- **Left-click** a node to pick it (gold), then **Find Path** to solve for every pick at once.
- **Right-click** a node to block it — the path must route around it. Right-click again to unblock.
- **Drag** to pan, **wheel** to zoom, **Share link** copies a URL encoding your picks and blocks.
- Every node is coloured by the mechanic its wheel belongs to, smalls included — dimmer
  for smalls, brighter for keystones, grey for travel nodes that belong to no mechanic.
  **Mechanics** opens the key; clicking a row (or a wheel centre) highlights those clusters.
  The fills are deliberately muted so that a picked node (gold) and the solved path (teal)
  are the brightest things on screen; the key and the cluster rings keep the vivid colours.

Node names are laid out at a fixed on-screen size and collision-checked: each tries
eight positions around its node, long names wrap to two lines, and higher-priority
names (hovered, picked, on-path, keystones) claim their spot first. A name with
nowhere to go is dropped rather than drawn over its neighbour — hover it for the
tooltip. `window.__atlas.labels` exposes the rects drawn last frame, which is how
the overlap check is run against randomised viewports.

The 33 mechanic colours live in `js/palette.js` and have two forms. `CATEGORY_COLOR` is the
*identity* colour — vivid, used by the key swatches, the ring on a wheel centre and the
cluster highlight. Mechanics whose colour the game already established are pinned; the rest
are solved for by `tools/gen-palette.mjs` so that no two wheels look alike.

What gets painted into a node is a muted derivative: `nodeColor()` scales chroma to 72% and
compresses lightness into a band capping at L\* 65, below path teal (L\* 76) and picked gold
(L\* 87). Without that, a Legion node at its identity cream (L\* 90) is *brighter* than the
selection and the eye has nothing to lock onto. The trade is real — mechanics sit ΔE 19
apart at identity but only ~10 apart once muted — which is what the key is for.

`node tools/check-palette.mjs` guards both: identity pairs must stay ΔE 18 apart, painted
fills ΔE 8, and every fill must be at least ΔE 20 from — and darker than — every selection
colour. Sampling the real canvas across 40 viewports agrees with it: brightest unselected
node L\* 65.0, dimmest selected L\* 76.3, worst-case ΔE 32.8.

The optimizer solves the Steiner tree problem on the atlas graph in a web worker, and
every answer is the true optimum — badged "✓ optimal" — however many nodes you pick.
Blocked-off picks are reported as unreachable rather than silently dropped.

Getting there needed a different algorithm. Dreyfus–Wagner is exact but costs 3^k in
the number of picks, so it was capped at 10 and everything past that fell back to
greedy insertion — which is wrong often enough to matter: on random 40-pick sets it
overspent on five of six, by 14 points in total, and on one 25-pick set in the browser
it asked for 127 points where 120 will do. `js/steiner-exact.js` instead runs a
dynamic program over a **tree decomposition** of the atlas. That is exponential in the
graph's *treewidth* rather than the pick count, and the atlas is rings joined by
corridors: treewidth 7, and most of its 903 bags hold two or three nodes. So 40 picks
cost the same as 4. Measured end to end through the worker, on this machine:

| picks | 5 | 10 | 20 | 40 | 80 | 120 | 241 (every notable) |
|---|---|---|---|---|---|---|---|
| solve | 132ms | 127ms | 161ms | 121ms | 138ms | 139ms | 152ms |

Flat, as promised — median of five, after a warm-up, since the first solve of a session
pays for the decomposition and the JIT. A single greedy pass still runs first, so there
is a shape on screen within a few milliseconds while the real solve works. Its
randomised restarts, though, now only run if the exact phase fails: they used to cost
every solve a couple hundred milliseconds for an answer that was about to be thrown
away. Dreyfus–Wagner is likewise kept only as a fallback for the small cases, in case a
decomposition ever comes up short. The decomposition itself depends only on which nodes
are blocked, not on what is picked, so it is built once (~40ms) and cached across solves.

The DP is checked against Dreyfus–Wagner rather than trusted: 394 randomised cases at
1–10 picks, mixed notables, smalls and keystones, a quarter of them with random blocked
sets, and the two agree on the cost every time. Past 10 picks DW can't answer, so the
assertions become structural — a real tree, over real edges, spanning every pick — plus
the requirement that exact never lose to the heuristic it replaced.

Routes across a wheel are frequently *tied*: where a wheel has an inner and an outer
ring, both reach the same notable in the same number of hops, so the tree costs the
same either way. Cost cannot choose between them, and an arbitrary winner is often
the one cutting across the middle — which looks like a detour even though it is not.
So each edge is charged 1024, plus 1 if it leaves the ring it started on. No tree has
1024 edges, so the penalties can never add up to a whole edge: the DP still minimises
point cost first and only spends what's left on staying on a ring. Over 40 random pick
sets that trims ring changes from 1719 to 1656 while changing no cost at all. To see
it, pick Fecund Colony and Broken Border — 21 points either way, but the path follows
the wheel instead of dipping through its middle.

Tree data is the official GGG export from
[grindinggear/atlastree-export](https://github.com/grindinggear/atlastree-export)
(vendored in `data/atlas.json`). To update for a new patch, replace that file with
the new `data.json` from the repo, and refresh `img/mastery.png` from the sprite
URL in its `sprites.mastery` section. Mechanic icon art © Grinding Gear Games.

No build step, no dependencies — serve the directory statically:

```
python3 -m http.server 8021
```

One caveat if you're editing it: `python3 -m http.server` sends no cache headers, so
browsers heuristically cache the ES modules and you can spend a while looking at code
you already changed. Hard-reload, or serve with `Cache-Control: no-store`.
