// Named sets of nodes to pick in one click. Each is a rule over the tree rather
// than a list of ids, so it survives a patch that renumbers or moves nodes — and
// a rule that stops matching anything simply drops out of the panel.
//
// tools/check-presets.mjs prints what each one matches.

// A choose-one notable keeps its text in its options, so those count too.
function anyStat(n, re) {
  const hit = (s) => re.test(s.replace(/\s+/g, " "));
  return n.stats.some(hit) || n.variants.some((v) => v.stats.some(hit));
}

export const PRESETS = [
  {
    name: "Map modifier effect",
    about: "every node that increases the effect of modifiers on your Maps, and the small nodes in those notables' wheels",
    has: (n) => anyStat(n, /increased effect of (Explicit|Prefix|Suffix) Modifiers on your Maps/),
    wheels: true,
  },
  {
    name: "Map tiers",
    about: "the Shaping notables that raise the tier of Maps found",
    has: (n) => n.type === "notable" && n.category === "Maps"
      && anyStat(n, /Maps found have \d+% chance to become 1 tier higher/),
  },
  {
    name: "Destructive Play",
    about: "Destructive Play, plus the notables that make map bosses drop Guardian, Conqueror and Synthesis Maps",
    has: (n) => n.name === "Destructive Play"
      || (n.type === "notable" && anyStat(n, /Map Boss/)
        && anyStat(n, /\b(Guardian|Conqueror|Synthesis) Map\b/)),
  },
];

// With `wheels`, a preset also takes the small nodes that share a wheel with one
// of its notables, whatever they grant.
export function presetNodes(preset, list) {
  const real = (n) => n.type !== "root" && n.type !== "wormhole";
  const hits = list.filter((n) => real(n) && preset.has(n));
  if (!preset.wheels) return hits;
  const wheels = new Set(hits.filter((n) => n.type === "notable").map((n) => n.group));
  return list.filter((n) => real(n) && (preset.has(n) || (n.type === "small" && wheels.has(n.group))));
}
