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

The optimizer solves the Steiner tree problem on the atlas graph in a web worker:
exact optimum (Dreyfus–Wagner) for up to 10 picks — badged "✓ optimal" — and a
greedy-insertion heuristic with randomized restarts and branch-reroute improvement
beyond that. Blocked-off picks are reported as unreachable rather than silently dropped.

Tree data is the official GGG export from
[grindinggear/atlastree-export](https://github.com/grindinggear/atlastree-export)
(vendored in `data/atlas.json`). To update for a new patch, replace that file with
the new `data.json` from the repo, and refresh `img/mastery.png` from the sprite
URL in its `sprites.mastery` section. Mechanic icon art © Grinding Gear Games.

No build step, no dependencies — serve the directory statically:

```
python3 -m http.server 8021
```
