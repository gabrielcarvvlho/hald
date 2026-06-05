// ================================================================
// Colors — centralized so dark mode (item #7) is a swap, not a hunt.
// All sigma renderer + reducer colors must read from here.
//
// Pure module: no DOM/window/Sigma access at top level, so the color
// math (hexToRgba/edgeAlphaFor/edgeColorFor/edgeSizeFor) imports
// cleanly into vitest. The active palette is held in a module-level
// `let` and exposed via getColors()/setColors() so theme.js can swap
// it and every other module sees the new value at render time without
// reassigning an imported binding.
// ================================================================

// Type chip colors stay the same in both themes — saturated enough
// to read against either bg. Defined once.
export const TYPE_COLORS = {
  PERSON: "#3b82f6",
  MODULE: "#10b981",
  TECHNOLOGY: "#f59e0b",
  DECISION: "#8b5cf6",
  PATTERN: "#ec4899",
  CONCEPT: "#14b8a6",
  RISK: "#ef4444",
  PROCESS: "#f97316",
};

export const COLORS_LIGHT = {
  nodeFallback: "#94a3b8",                  // slate-400
  nodeBorder: "#ffffff",
  // intra bright + cross dim creates clear "this group is together"
  // hierarchy without visual clutter from low-weight cross-cluster lines.
  // Edge color is now computed per-edge from weight; these stay as fallback
  // and as the `defaultEdgeColor` for sigma's settings (avg-weight color).
  edgeIntra: "rgba(100,116,139,0.65)",      // slate-500, prominent
  edgeCross: "rgba(148,163,184,0.22)",      // slate-400, recedes
  edgeDefault: "rgba(100,116,139,0.5)",
  // RGB tuples (no alpha) — used by edgeColor() to mix per-edge alpha
  // proportional to weight. Keeps low-weight edges quiet, lets heavy ones
  // sing. Without this, every edge reads with the same visual weight and
  // hierarchy collapses.
  edgeIntraRgb: [100, 116, 139],            // slate-500
  edgeCrossRgb: [148, 163, 184],            // slate-400
  // Path-highlighting accent — distinct from any community color so
  // the "thread" through the graph reads as a separate semantic layer.
  pathEdge: "rgba(217,119,6,0.90)",         // amber-600 against light bg
  pathNodeRing: "#d97706",                  // amber-600 — for path-node ring
  labelText: "#1e293b",                     // slate-800
  // Hover label "pill" — sigma's default is hardcoded white, which collides
  // with light-text label colors in dark mode. We draw it ourselves; these
  // tokens give it a contrasting bg + text per theme.
  hoverLabelBg: "#ffffff",
  hoverLabelText: "#0f172a",                // slate-900
  hoverLabelBorder: "rgba(15,23,42,0.10)",
  hoverShadow: "rgba(15,23,42,0.18)",
  dimNode: "#e2e8f0",                       // slate-200 — barely visible
  dimEdge: "rgba(226,232,240,0.18)",
  hoverEdge: "#94a3b8",
  typeColors: TYPE_COLORS,
};

export const COLORS_DARK = {
  nodeFallback: "#64748b",                  // slate-500
  nodeBorder: "#0b1220",                    // matches dark bg, blends border
  edgeIntra: "rgba(148,163,184,0.55)",      // slate-400, prominent against dark bg
  edgeCross: "rgba(100,116,139,0.18)",      // slate-500, very subtle
  edgeDefault: "rgba(148,163,184,0.4)",
  edgeIntraRgb: [148, 163, 184],            // slate-400
  edgeCrossRgb: [100, 116, 139],            // slate-500
  // Path accent in dark mode — brighter amber so it pops against the
  // slate-blue background. Same hue family as the light-mode token.
  pathEdge: "rgba(251,191,36,0.92)",        // amber-300
  pathNodeRing: "#fbbf24",                  // amber-300
  labelText: "#f1f5f9",                     // slate-100
  // Dark-mode hover pill: dark surface + light text. Sigma's built-in
  // hover renderer uses white bg unconditionally, which made highlighted
  // labels unreadable in dark mode (white text on white pill).
  hoverLabelBg: "#1e293b",                  // slate-800
  hoverLabelText: "#f8fafc",                // slate-50
  hoverLabelBorder: "rgba(148,163,184,0.25)",
  hoverShadow: "rgba(0,0,0,0.55)",
  dimNode: "#1f2937",                       // gray-800 — barely visible against dark bg
  dimEdge: "rgba(31,41,55,0.35)",
  hoverEdge: "#94a3b8",
  typeColors: TYPE_COLORS,
};

// Mutable reference. setupTheme() / applyTheme() swap this between
// light and dark via setColors(); nodeReducer/edgeReducer read it at
// render time via getColors() so dim/hover colors update on theme
// change without rebuilding.
let COLORS = COLORS_LIGHT;

export function getColors() {
  return COLORS;
}

export function setColors(palette) {
  COLORS = palette;
}

// Convert hex (#rgb / #rrggbb) to rgba(r,g,b,a). Falls back to slate-400
// if input is unparseable so a bad community color can never break render.
export function hexToRgba(hex, alpha) {
  if (typeof hex !== "string") return `rgba(148,163,184,${alpha})`;
  let h = hex.trim().replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6) return `rgba(148,163,184,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return `rgba(148,163,184,${alpha})`;
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

// Per-edge alpha based on weight. Light, infrequent connections recede;
// heavy ones stand out. Cross-cluster edges start dimmer than intra so
// the visual story is "communities are tight, bridges are real but quiet".
export function edgeAlphaFor(weight, isCross) {
  const base = isCross ? 0.16 : 0.42;
  const boost = Math.min(0.42, Math.log((weight ?? 1) + 1) * 0.12);
  return Math.min(0.88, base + boost);
}

export function edgeColorFor(weight, isCross, palette) {
  const rgb = isCross ? palette.edgeCrossRgb : palette.edgeIntraRgb;
  const a = edgeAlphaFor(weight, isCross);
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`;
}

// Edge size scales log-monotonically with weight. Range 0.5–3.0 px:
// dot edges for w=1, beefy lines for w≥30. Old range topped out at
// 1.65 which made the heaviest connections still feel thin.
export function edgeSizeFor(weight) {
  return 0.5 + Math.min(2.5, Math.log((weight ?? 1) + 1) * 0.7);
}
