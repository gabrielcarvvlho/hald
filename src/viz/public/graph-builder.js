/* global graphology */

// ================================================================
// Build Graph
// ================================================================

import { state } from "./state.js";
import {
  getColors,
  hexToRgba,
  edgeSizeFor,
  edgeColorFor,
} from "./colors.js";
import { HALO_PREFIX, HALO_SIZE_MULT, isHalo } from "./halo.js";
import { initMotion } from "./motion.js";

export function buildGraph(data) {
  const COLORS = getColors();
  const Graph = graphology.Graph;
  const graph = new Graph();

  // Truncation indicator. On large repos the server caps the graph to
  // the top entities/relations; surface that so users know they're
  // looking at a slice, not the whole repo. Hidden when nothing dropped.
  state.truncation = data.truncated || null;
  renderTruncationBadge(state.truncation);

  // Store community colors
  for (const c of data.communities) {
    state.communityColors[c.id] = c.color;
  }

  // Add nodes. Tight size range so non-hub nodes are dots (1.8px)
  // and only the highest-frequency entities pop up to ~7px.
  // The visual story is "communities of dots with a few anchors,"
  // not "everything is a labeled blob."
  for (const node of data.nodes) {
    const color = node.communityId
      ? (state.communityColors[node.communityId] || COLORS.nodeFallback)
      : COLORS.nodeFallback;
    const size = 1.8 + Math.min(5.2, Math.log(node.frequency + 1) * 1.5);

    graph.addNode(node.id, {
      x: node.x,
      y: node.y,
      size: size,
      color: color,
      label: node.name,
      // Custom data for filtering/display
      nodeType: node.type,
      communityId: node.communityId,
      borderColor: COLORS.nodeBorder,
    });
  }

  // Add edges. Each edge stores its raw weight as an attribute so
  // applyTheme() can recompute color (alpha depends on weight + theme)
  // without re-running the whole build path.
  for (const edge of data.edges) {
    let sourceCommunity = null;
    let targetCommunity = null;
    try {
      sourceCommunity = graph.getNodeAttribute(edge.source, "communityId");
      targetCommunity = graph.getNodeAttribute(edge.target, "communityId");
    } catch (e) {
      // Node may not exist
    }
    const isCross = sourceCommunity !== targetCommunity;

    try {
      graph.addEdge(edge.source, edge.target, {
        size: edgeSizeFor(edge.weight),
        color: edgeColorFor(edge.weight, isCross, COLORS),
        edgeType: edge.type,
        weight: edge.weight,
      });
    } catch (e) {
      // Skip duplicate edges
    }
  }

  // Pre-compute neighbor sets for hover effects.
  // IMPORTANT: this runs BEFORE halos are added — halos must not
  // appear in any neighbor set or hover dim/lift logic gets confused.
  graph.forEachNode((node) => {
    state.neighbors.set(node, new Set(graph.neighbors(node)));
  });

  // Force-label only the top 3 most-connected nodes — they act as
  // anchors. The rest reveal on hover/search. Whisper until asked.
  // Also runs BEFORE halos so they never get force-labeled.
  const ranked = [];
  graph.forEachNode((node) => {
    ranked.push({ node, degree: graph.degree(node) });
  });
  ranked.sort((a, b) => b.degree - a.degree);
  for (const { node } of ranked.slice(0, 3)) {
    graph.setNodeAttribute(node, "forceLabel", true);
  }

  // Lift real nodes above halos. Sigma's renderer respects zIndex
  // when `zIndex: true` is in settings.
  graph.forEachNode((node) => {
    graph.setNodeAttribute(node, "zIndex", 1);
  });

  // Halo layer — drawn behind every real node. Same x/y, larger size,
  // low-alpha color. Halo IDs are prefixed so we can detect them in
  // event handlers and reducers without leaking into search/sidebar.
  const realIds = [];
  graph.forEachNode((id) => {
    if (!isHalo(id)) realIds.push(id);
  });
  for (const id of realIds) {
    const a = graph.getNodeAttributes(id);
    graph.addNode(HALO_PREFIX + id, {
      x: a.x,
      y: a.y,
      size: a.size * HALO_SIZE_MULT,
      // Resting halo color is fully transparent — the reducer
      // overrides it with HALO_ALPHA_ACTIVE only when the parent
      // node becomes active. Sigma still needs a valid color string.
      color: hexToRgba(a.color, 0),
      label: "",
      // nodeType uses an unmatchable sentinel so type filters never
      // accidentally hide/show halos through the chip path.
      nodeType: "__halo__",
      communityId: a.communityId,
      _halo: true,
      _haloOf: id,
      zIndex: 0,
    });
  }

  state.graph = graph;
  initMotion(graph);
}

// ================================================================
// Truncation badge
// ================================================================
// Small "showing top N of M entities" pill, rendered into
// #graph-container. CSS class `.graph-truncation-badge` is owned by the
// stylesheet (see style.css). The element is created lazily and toggled
// (not removed) so repeated builds don't churn the DOM. When the graph
// fits under the cap (truncation === null), the badge is hidden.
function renderTruncationBadge(truncation) {
  const container = document.getElementById("graph-container");
  if (!container) return;

  let badge = document.getElementById("graph-truncation-badge");
  if (!truncation) {
    if (badge) badge.style.display = "none";
    return;
  }

  if (!badge) {
    badge = document.createElement("div");
    badge.id = "graph-truncation-badge";
    badge.className = "graph-truncation-badge";
    container.appendChild(badge);
  }

  // Lead with entities (the headline number). Mention edges only when
  // they were also capped, so the badge stays terse on the common case.
  const n = truncation.shownNodes.toLocaleString();
  const m = truncation.totalNodes.toLocaleString();
  let text = `Showing top ${n} of ${m} entities`;
  if (truncation.shownEdges < truncation.totalEdges) {
    const e = truncation.shownEdges.toLocaleString();
    const t = truncation.totalEdges.toLocaleString();
    text += ` · ${e} of ${t} relations`;
  }
  badge.textContent = text;
  badge.style.display = "";
}
