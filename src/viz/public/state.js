// ================================================================
// State — single shared mutable singleton
// ================================================================
// Every module imports this one `state` object. The graphology graph,
// the Sigma renderer instance, hover/selection, filters, motion, and
// path-highlighting state all live here. Do not duplicate any of it.

export const state = {
  renderer: null,
  graph: null,
  hoveredNode: null,
  selectedNode: null,
  searchQuery: "",
  hiddenTypes: new Set(),
  communityColors: {},
  neighbors: new Map(), // nodeId → Set<nodeId>
  overlayOpen: false,
  // Populated by setupCommunityLabels(); read by the per-render
  // positioner and the screenshot compositor.
  communityLabels: [],
  motion: {
    enabled: false,
    rafId: null,
    baselines: new Map(), // realNodeId → {x, y} at layout time
    phases: new Map(),    // realNodeId → {fx, fy, phx, phy, ax, ay}
    pulses: new Map(),    // realNodeId → start ms (hover ripple)
  },
  // Path highlighting — populated when user cmd-clicks a second node
  // while one is selected. nodeSet/edgeSet exist for O(1) lookups in
  // the per-frame reducer + edge drawer. edgeTypes is parallel to the
  // gaps between nodes (length === nodes.length - 1) and powers the
  // semantic banner label between hops.
  path: {
    active: false,
    nodes: [],            // ordered: [from, ..., to]
    edgeTypes: [],        // edgeType per gap; null when edge is missing
    nodeSet: new Set(),
    edgeSet: new Set(),
    fromId: null,
    toId: null,
    errorTimerId: null,
  },
};

export function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
