// ================================================================
// Theme — light / dark, persisted to localStorage, default from
// prefers-color-scheme. Sigma settings (defaultEdgeColor, labelColor)
// must be re-applied on theme change because sigma reads them once
// at renderer creation. Per-edge stored colors also need refresh.
// ================================================================

import { state } from "./state.js";
import {
  COLORS_LIGHT,
  COLORS_DARK,
  getColors,
  setColors,
  edgeColorFor,
} from "./colors.js";
import { isHalo } from "./halo.js";

const THEME_KEY = "hald-theme";

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  setColors(theme === "dark" ? COLORS_DARK : COLORS_LIGHT);
  const COLORS = getColors();
  if (!state.renderer || !state.graph) return;

  state.renderer.setSetting("defaultNodeColor", COLORS.nodeFallback);
  state.renderer.setSetting("defaultEdgeColor", COLORS.edgeDefault);
  state.renderer.setSetting("labelColor", { color: COLORS.labelText });

  // Re-apply per-edge colors. Color is now weight-aware and theme-aware,
  // so we rebuild it from the stored `weight` attribute set in buildGraph.
  // Per-node base colors come from the community palette (theme-stable),
  // so real nodes don't need re-coloring; halos read from real nodes via
  // the reducer at draw time.
  state.graph.forEachEdge((edge) => {
    const sourceCommunity = state.graph.getNodeAttribute(
      state.graph.source(edge),
      "communityId",
    );
    const targetCommunity = state.graph.getNodeAttribute(
      state.graph.target(edge),
      "communityId",
    );
    const isCross = sourceCommunity !== targetCommunity;
    const weight = state.graph.getEdgeAttribute(edge, "weight") ?? 1;
    state.graph.setEdgeAttribute(
      edge,
      "color",
      edgeColorFor(weight, isCross, COLORS),
    );
  });

  // Refresh node border in case theme inverts it (light=white, dark=bg).
  // Skip halos — they stay borderless across themes.
  state.graph.forEachNode((node) => {
    if (isHalo(node)) return;
    state.graph.setNodeAttribute(node, "borderColor", COLORS.nodeBorder);
  });

  state.renderer.refresh();
}

export function setupTheme() {
  let initial;
  try {
    initial = localStorage.getItem(THEME_KEY);
  } catch (_e) {
    // localStorage may be blocked in some contexts; ignore.
  }
  if (initial !== "light" && initial !== "dark") {
    initial = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  applyTheme(initial);

  const btn = document.getElementById("btn-theme");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme || "light";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (_e) {
      // ignore
    }
  });
}
