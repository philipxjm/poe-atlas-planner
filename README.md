# PoE Atlas Planner

Path of Exile atlas passive tree planner (3.29 data): pick the notables and keystones
you want, and it computes the minimum-point connected tree that reaches all of them.

- **Left-click** a node to pick it (gold). The optimal path (teal) recomputes instantly.
- **Right-click** a node to block it — the path must route around it. Right-click again to unblock.
- **Drag** to pan, **wheel** to zoom, **Share link** copies a URL encoding your picks and blocks.

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
