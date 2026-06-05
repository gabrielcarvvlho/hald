/* global Sigma */

// ================================================================
// Renderer — Sigma instance, custom hover, node/edge reducers
// ================================================================

import { state, prefersReducedMotion } from "./state.js";
import { getColors, hexToRgba } from "./colors.js";
import { HALO_ALPHA_ACTIVE, HALO_ACTIVE_GROW } from "./halo.js";
import { pulseSizeMult } from "./motion.js";

// ================================================================
// Create Renderer
// ================================================================

export function createRenderer() {
  const COLORS = getColors();
  const container = document.getElementById("graph-container");
  const renderer = new Sigma(state.graph, container, {
    defaultNodeColor: COLORS.nodeFallback,
    defaultEdgeColor: COLORS.edgeDefault,
    labelFont: "system-ui, sans-serif",
    labelColor: { color: COLORS.labelText },
    labelSize: 11,
    // Hard threshold: only nodes rendered ≥12px get auto-labels. With
    // size range 1.8–7px, this means the only labels visible by
    // default are the top-3 forced ones. Hover reveals everything.
    labelRenderedSizeThreshold: 12,
    labelDensity: 0.4,
    labelGridCellSize: 100,
    nodeProgramClasses: {},
    nodeReducer: nodeReducer,
    edgeReducer: edgeReducer,
    // Override sigma's default hover renderer. The built-in one paints a
    // hardcoded white pill behind the label, so in dark mode (with light
    // label text) the highlighted node became unreadable: white text on
    // white pill. Our renderer reads from the active COLORS palette.
    defaultDrawNodeHover: drawNodeHover,
    zIndex: true,
    minCameraRatio: 0.02,
    maxCameraRatio: 10,
  });

  state.renderer = renderer;

  // Brief settle animation on first paint — leave ~30% padding around
  // the graph so users don't feel boxed in. The slight zoom-in starting
  // state pulls back to give a sense of "settling into view." Reduced-
  // motion users skip the animated pull-back and land directly at the
  // resting camera state.
  const camera = renderer.getCamera();
  if (prefersReducedMotion()) {
    camera.setState({ x: 0.5, y: 0.5, ratio: 1.3, angle: 0 });
  } else {
    camera.setState({ x: 0.5, y: 0.5, ratio: 1.5, angle: 0 });
    requestAnimationFrame(() => {
      camera.animate({ x: 0.5, y: 0.5, ratio: 1.3, angle: 0 }, { duration: 700 });
    });
  }
}

// ================================================================
// Custom node-hover renderer
// ================================================================
// Sigma's default hover renderer hardcodes the label-pill background
// to white — fine in light mode, unreadable in dark mode (light label
// text on a white pill). This renderer mirrors the original geometry
// (rounded pill aligned to the node disc) but pulls every color from
// the active COLORS palette, so dark mode gets a slate-800 pill with
// slate-50 text.
function drawNodeHover(ctx, data, settings) {
  const COLORS = getColors();
  const size = settings.labelSize;
  const font = settings.labelFont;
  const weight = settings.labelWeight ?? "";
  const padX = 5;
  const padY = 2;

  ctx.font = `${weight} ${size}px ${font}`.trim();
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 1;
  ctx.shadowBlur = 8;
  ctx.shadowColor = COLORS.hoverShadow;
  ctx.fillStyle = COLORS.hoverLabelBg;

  if (typeof data.label === "string" && data.label) {
    const textWidth = ctx.measureText(data.label).width;
    const pillWidth = Math.round(textWidth + padX);
    const pillHeight = Math.round(size + 2 * padY);
    const radius = Math.max(data.size, size / 2) + padY;
    const angle = Math.asin(pillHeight / 2 / radius);
    const arcEdgeX = Math.sqrt(Math.abs(radius * radius - (pillHeight / 2) * (pillHeight / 2)));

    ctx.beginPath();
    ctx.moveTo(data.x + arcEdgeX, data.y + pillHeight / 2);
    ctx.lineTo(data.x + radius + pillWidth, data.y + pillHeight / 2);
    ctx.lineTo(data.x + radius + pillWidth, data.y - pillHeight / 2);
    ctx.lineTo(data.x + arcEdgeX, data.y - pillHeight / 2);
    ctx.arc(data.x, data.y, radius, angle, -angle);
    ctx.closePath();
    ctx.fill();

    // Subtle border separates the pill from same-tone backgrounds
    // (mostly noticeable in dark mode against the canvas bg).
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.hoverLabelBorder;
    ctx.stroke();

    // Label text — theme-aware, drawn last so it sits on top.
    ctx.fillStyle = COLORS.hoverLabelText;
    ctx.fillText(data.label, data.x + data.size + 3, data.y + size / 3);
  } else {
    // No label: keep sigma's halo behavior (a slightly bigger disc).
    ctx.beginPath();
    ctx.arc(data.x, data.y, data.size + padY, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowBlur = 0;
  }
}

// ================================================================
// Reducers
// ================================================================

function nodeReducer(node, data) {
  const COLORS = getColors();
  // Halo branch. Halos are HIDDEN by default — only the currently
  // active (hovered or selected) node's halo renders. This keeps
  // resting state clean (no donut/bullseye look from overlapping
  // discs) while still giving hover its lift. Sigma's disc shader is
  // hard-edged so multiple translucent halos compound visually; one
  // halo at a time avoids that compounding entirely.
  if (data._halo) {
    const activeNode = state.hoveredNode || state.selectedNode;
    if (!activeNode || data._haloOf !== activeNode) {
      return { ...data, hidden: true };
    }
    const g = state.graph;
    if (!g || !g.hasNode(activeNode)) return { ...data, hidden: true };
    const real = g.getNodeAttributes(activeNode);
    // Even when active, mirror hide-by-type and search dim so the
    // halo doesn't pop on a node that's been filtered out.
    if (state.hiddenTypes.has(real.nodeType)) return { ...data, hidden: true };
    if (state.searchQuery) {
      const matches =
        typeof real.label === "string" &&
        real.label.toLowerCase().includes(state.searchQuery);
      if (!matches) return { ...data, hidden: true };
    }
    return {
      ...data,
      size: data.size * HALO_ACTIVE_GROW,
      color: hexToRgba(real.color, HALO_ALPHA_ACTIVE),
      zIndex: 0,
    };
  }

  const res = { ...data };

  // Type filtering. forceLabel is cleared explicitly here (and in every
  // dim/hide branch below) because the top-degree anchors carry a sticky
  // forceLabel=true from buildGraph(); without resetting it, a hidden or
  // dimmed anchor would keep forcing its label. Label-forcing must be
  // fully state-driven, never a stale build-time flag.
  if (state.hiddenTypes.has(data.nodeType)) {
    res.hidden = true;
    res.forceLabel = false;
    return res;
  }

  // Path mode is the dominant baseline when active. Path nodes lift
  // and force their label; non-path nodes dim and lose their label.
  // Hover/select can still apply on top (halo, ripple) but cannot
  // un-dim non-path nodes — the path is the dominant focus.
  const pathActive = state.path.active;
  const inPath = pathActive && state.path.nodeSet.has(node);
  let pathLift = 1;
  if (pathActive) {
    if (inPath) {
      pathLift =
        node === state.path.fromId || node === state.path.toId ? 1.30 : 1.12;
      res.size = data.size * pathLift;
      res.zIndex = 3;
      res.forceLabel = true;
    } else {
      res.color = COLORS.dimNode;
      res.label = "";
      res.forceLabel = false;
      res.zIndex = 0;
    }
  }

  // Search dimming. Path nodes are exempt from search-dim so the
  // thread stays visible while you scan within it.
  if (state.searchQuery) {
    const matches = data.label.toLowerCase().includes(state.searchQuery);
    if (!matches) {
      if (!inPath) {
        res.color = COLORS.dimNode;
        res.label = "";
        res.forceLabel = false;
        res.zIndex = 0;
      }
    } else {
      res.highlighted = true;
      res.zIndex = Math.max(res.zIndex || 0, 2);
    }
  }

  // Hover / selection highlight. Active node always lifts and undims.
  // Non-active path nodes never re-dim from a hover on something else.
  const activeNode = state.hoveredNode || state.selectedNode;
  if (activeNode) {
    if (node === activeNode) {
      res.highlighted = true;
      res.size = data.size * 1.4 * pathLift;
      res.zIndex = Math.max(res.zIndex || 0, 2);
      // Active node is never dimmed even outside the path.
      if (res.color === COLORS.dimNode) res.color = data.color;
      if (res.label === "") res.label = data.label;
    } else {
      const neighbors = state.neighbors.get(activeNode);
      if (neighbors && neighbors.has(node)) {
        res.zIndex = Math.max(res.zIndex || 0, 1);
      } else if (!inPath) {
        // Non-path, non-neighbor — dim it. Path nodes were already
        // handled above and stay lit.
        res.color = COLORS.dimNode;
        res.label = "";
        res.forceLabel = false;
        res.zIndex = 0;
      }
    }
  }

  // Hover ripple — neighbors of the active node briefly pulse.
  // Applied last so it stacks on whatever size we already settled on
  // (active highlight × 1.4 still gets the ripple multiplier on top).
  if (state.motion.enabled) {
    const mult = pulseSizeMult(node, performance.now());
    if (mult !== 1) {
      res.size = (res.size ?? data.size) * mult;
    }
  }

  return res;
}

function edgeReducer(edge, data) {
  // Edges are rendered by the 2D curved-edge overlay (drawCurvedEdges).
  // Telling sigma to skip its WebGL edge pass entirely avoids a double
  // render — straight WebGL line under our curve. All previous logic
  // (dim on hover, hide on type-filter) lives in drawCurvedEdges now.
  return { ...data, hidden: true };
}
