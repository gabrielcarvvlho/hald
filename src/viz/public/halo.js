// ================================================================
// Halo layer identity
// ================================================================
// Obsidian-style hover: the active node lights up with a soft glow,
// every other node stays clean. We get that with duplicate "halo"
// nodes co-located with each real node — drawn at a lower zIndex
// and HIDDEN BY DEFAULT. The reducer reveals the halo only for the
// node currently being hovered or selected. Resting state has zero
// halos visible, which keeps clusters reading as clusters of small
// dots, not as overlapping donuts.
//
// Halos are ignored by search, type filters, the sidebar, and click
// events (clicks/hovers remap halo → real so the larger hit area
// still feels like interacting with the underlying node).
//
// Future option: soft Gaussian glow via a custom WebGL fragment
// shader. Would let us bring back ambient halos without the
// hard-edge donut artifact. Deferred — needs build infra to inject
// a NodeProgram subclass into the vendored sigma UMD.
//
// This module is pure (no DOM/window/Sigma) so it imports cleanly
// into both the browser app and the vitest test suite (path.js uses
// isHalo during BFS).

export const HALO_PREFIX = "__halo__";
// Tuned to read as a refined selection RING, not a spotlight. Real
// node sits on top at zIndex 1, so the visible halo is just the
// outer annulus — ~0.7× the node radius wide, low alpha. Anything
// larger or more opaque started feeling like a target reticle around
// small dots.
export const HALO_SIZE_MULT = 1.6;       // halo radius = 1.6× node radius
export const HALO_ALPHA_ACTIVE = 0.20;   // hover/select — present but quiet
export const HALO_ACTIVE_GROW = 1.08;    // tiny extra grow on the active node so hover registers as motion

export function isHalo(nodeId) {
  return typeof nodeId === "string" && nodeId.startsWith(HALO_PREFIX);
}
