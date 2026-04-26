/* global graphology, Sigma */

import { parseHash, serializeState } from "./url-state.js";

// ================================================================
// Colors — centralized so dark mode (item #7) is a swap, not a hunt.
// All sigma renderer + reducer colors must read from here.
// ================================================================

// Type chip colors stay the same in both themes — saturated enough
// to read against either bg. Defined once.
const TYPE_COLORS = {
  PERSON: "#3b82f6",
  MODULE: "#10b981",
  TECHNOLOGY: "#f59e0b",
  DECISION: "#8b5cf6",
  PATTERN: "#ec4899",
  CONCEPT: "#14b8a6",
  RISK: "#ef4444",
  PROCESS: "#f97316",
};

const COLORS_LIGHT = {
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

const COLORS_DARK = {
  nodeFallback: "#64748b",                  // slate-500
  nodeBorder: "#0b1220",                    // matches dark bg, blends border
  edgeIntra: "rgba(148,163,184,0.55)",      // slate-400, prominent against dark bg
  edgeCross: "rgba(100,116,139,0.18)",      // slate-500, very subtle
  edgeDefault: "rgba(148,163,184,0.4)",
  edgeIntraRgb: [148, 163, 184],            // slate-400
  edgeCrossRgb: [100, 116, 139],            // slate-500
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
// light and dark; nodeReducer/edgeReducer read it at render time so
// dim/hover colors update on theme change without rebuilding.
let COLORS = COLORS_LIGHT;

// ================================================================
// Halo layer + color helpers
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

const HALO_PREFIX = "__halo__";
const HALO_SIZE_MULT = 1.6;       // halo radius = 1.6× node radius
const HALO_ALPHA_ACTIVE = 0.20;   // hover/select — present but quiet
const HALO_ACTIVE_GROW = 1.08;    // tiny extra grow on the active node so hover registers as motion

function isHalo(nodeId) {
  return typeof nodeId === "string" && nodeId.startsWith(HALO_PREFIX);
}

// Convert hex (#rgb / #rrggbb) to rgba(r,g,b,a). Falls back to slate-400
// if input is unparseable so a bad community color can never break render.
function hexToRgba(hex, alpha) {
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
function edgeAlphaFor(weight, isCross) {
  const base = isCross ? 0.16 : 0.42;
  const boost = Math.min(0.42, Math.log((weight ?? 1) + 1) * 0.12);
  return Math.min(0.88, base + boost);
}

function edgeColorFor(weight, isCross, palette) {
  const rgb = isCross ? palette.edgeCrossRgb : palette.edgeIntraRgb;
  const a = edgeAlphaFor(weight, isCross);
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`;
}

// Edge size scales log-monotonically with weight. Range 0.5–3.0 px:
// dot edges for w=1, beefy lines for w≥30. Old range topped out at
// 1.65 which made the heaviest connections still feel thin.
function edgeSizeFor(weight) {
  return 0.5 + Math.min(2.5, Math.log((weight ?? 1) + 1) * 0.7);
}

// ================================================================
// Motion — P1.A breathing + P1.B hover ripple
// ================================================================
// Two effects share one requestAnimationFrame loop:
//
//   1. Breathing: each real node oscillates around its FA2-computed
//      baseline using uncorrelated sine waves. Per-node phase and
//      frequency come from a hash of the node id, so motion is
//      deterministic across reloads (good for screenshots/UX) and
//      uncorrelated across the cluster (no synchronized pulsing).
//
//   2. Ripple: when the user hovers a node, its neighbors briefly
//      pulse (size grows then returns) on a smoothstep curve. The
//      pulse map is read in nodeReducer; the loop drives refresh.
//
// Why sin oscillation instead of continuous ForceAtlas2: FA2 in the
// browser would need a worker bundle of the graphology layout pkg
// in vendor/. Sine drift gets the "alive" feel for free, can't
// destroy the layout (always returns to baseline), and costs ~0ms
// for 200 nodes per tick.
//
// `prefers-reduced-motion: reduce` disables breathing AND ripple
// entirely — accessibility takes precedence over polish.

const MOTION_AMP = 1.2;            // graph units; layout scale ≈ 100 → ~1.2% drift
const MOTION_PULSE_MS = 360;       // total ripple duration
const MOTION_PULSE_PEAK = 0.18;    // size multiplier add at peak (1.0 → 1.18 → 1.0)
const MOTION_PULSE_RETRIGGER = 0.6; // ignore re-pulses on a node within 60% of duration

function smoothstep(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

function strHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// ================================================================
// State
// ================================================================

const state = {
  renderer: null,
  graph: null,
  hoveredNode: null,
  selectedNode: null,
  searchQuery: "",
  hiddenTypes: new Set(),
  communityColors: {},
  neighbors: new Map(), // nodeId → Set<nodeId>
  overlayOpen: false,
  motion: {
    enabled: false,
    rafId: null,
    baselines: new Map(), // realNodeId → {x, y} at layout time
    phases: new Map(),    // realNodeId → {fx, fy, phx, phy, ax, ay}
    pulses: new Map(),    // realNodeId → start ms (hover ripple)
  },
};

// ================================================================
// Init
// ================================================================

async function init() {
  const loadingEl = document.getElementById("loading");

  if (typeof graphology === "undefined" || typeof Sigma === "undefined") {
    loadingEl.textContent = "Failed to load graph engine. Try rebuilding with `npm run build`.";
    loadingEl.classList.add("error");
    return;
  }

  try {
    const [graphData, statsData] = await Promise.all([
      fetch("/api/graph").then((r) => r.json()),
      fetch("/api/stats").then((r) => r.json()),
    ]);

    // Render stats
    renderStats(statsData);

    // Check empty
    if (graphData.nodes.length === 0) {
      loadingEl.innerHTML =
        '<div class="empty-state"><div class="empty-state-title">No entities found</div>' +
        '<div class="empty-state-text">Try indexing more commits with <code>hald scan</code></div></div>';
      return;
    }

    // Remove loading
    loadingEl.remove();

    // Restore state from URL hash before chips/filters render so the
    // "active" markers match. selected node is restored AFTER renderer
    // is wired (selectNode needs renderer).
    const initialState = parseHash(window.location.hash);
    for (const t of initialState.hide) state.hiddenTypes.add(t);

    // Build graph + render
    buildGraph(graphData);
    createRenderer();
    setupTypeChips(graphData);
    setupEvents();
    setupSearch();
    setupFilters();
    setupCommunityLabels(graphData);
    setupScreenshot();
    setupKeyboardShortcuts();
    setupTheme();
    setupClusterOverlay();
    // Start the breathing/ripple RAF loop. No-ops if the user has
    // prefers-reduced-motion: reduce. Must come after createRenderer
    // so state.renderer is set and the camera's intro animation has
    // already kicked off (motion takes over once intro finishes).
    startMotionLoop();

    // Restore selected node if URL had one and it exists in the graph.
    if (initialState.node && state.graph.hasNode(initialState.node)) {
      selectNode(initialState.node);
    }
  } catch (err) {
    loadingEl.textContent = "Failed to load graph data: " + err.message;
    loadingEl.classList.add("error");
  }
}

// ================================================================
// Stats
// ================================================================

function renderStats(stats) {
  const el = document.getElementById("stats-text");
  const parts = [];
  if (stats.entities) parts.push(stats.entities + " entities");
  if (stats.relations) parts.push(stats.relations + " relations");
  if (stats.communities) parts.push(stats.communities + " communities");
  el.textContent = parts.join(" \u00b7 ");
}

// ================================================================
// Build Graph
// ================================================================

function buildGraph(data) {
  const Graph = graphology.Graph;
  const graph = new Graph();

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
// Motion init + loop
// ================================================================
//
// initMotion() runs after halos are added. It snapshots each real
// node's baseline position and assigns deterministic per-node phase
// + frequency + amplitude from the node id's hash. With independent
// sin oscillators per node, the cluster wanders organically without
// synchronized pulsing.

function initMotion(graph) {
  state.motion.baselines.clear();
  state.motion.phases.clear();
  state.motion.pulses.clear();
  graph.forEachNode((id, attrs) => {
    if (isHalo(id)) return;
    state.motion.baselines.set(id, { x: attrs.x, y: attrs.y });
    const h = strHash(id);
    state.motion.phases.set(id, {
      // Frequencies in 0.18–0.40 rad/sec → periods 16–35 sec. Slow
      // enough to read as "alive", not as "panning".
      fx: 0.18 + ((h & 0xff) / 0xff) * 0.22,
      fy: 0.18 + (((h >> 8) & 0xff) / 0xff) * 0.22,
      phx: (((h >> 16) & 0xff) / 0xff) * Math.PI * 2,
      phy: (((h >> 24) & 0xff) / 0xff) * Math.PI * 2,
      // Amplitude jitter so neighbors don't trace identical orbits.
      ax: 0.7 + ((h & 0xf) / 0xf) * 0.6,
      ay: 0.7 + (((h >> 4) & 0xf) / 0xf) * 0.6,
    });
  });
}

function startMotionLoop() {
  if (state.motion.enabled) return;
  // Honor accessibility preference. With reduced motion, neither
  // breathing nor ripple ever fires — sigma renders on demand only.
  if (prefersReducedMotion()) {
    state.motion.enabled = false;
    return;
  }
  state.motion.enabled = true;

  const tick = (nowMs) => {
    if (!state.renderer || !state.graph) {
      state.motion.rafId = requestAnimationFrame(tick);
      return;
    }
    const t = nowMs / 1000;
    const g = state.graph;

    // Breathing — drift each real node + co-located halo.
    state.motion.baselines.forEach((origin, id) => {
      if (!g.hasNode(id)) return;
      const ph = state.motion.phases.get(id);
      if (!ph) return;
      const dx = MOTION_AMP * ph.ax * Math.sin(t * ph.fx + ph.phx);
      const dy = MOTION_AMP * ph.ay * Math.sin(t * ph.fy + ph.phy);
      const x = origin.x + dx;
      const y = origin.y + dy;
      g.setNodeAttribute(id, "x", x);
      g.setNodeAttribute(id, "y", y);
      const haloId = HALO_PREFIX + id;
      if (g.hasNode(haloId)) {
        g.setNodeAttribute(haloId, "x", x);
        g.setNodeAttribute(haloId, "y", y);
      }
    });

    // Sweep stale pulses so the map stays small over long sessions.
    state.motion.pulses.forEach((startMs, id) => {
      if (nowMs - startMs > MOTION_PULSE_MS) {
        state.motion.pulses.delete(id);
      }
    });

    state.renderer.refresh();
    state.motion.rafId = requestAnimationFrame(tick);
  };
  state.motion.rafId = requestAnimationFrame(tick);
}

// Trigger ripple on neighbors of a node. Re-trigger guard: if a
// pulse is still in its early phase, leave it alone — replaying
// from start mid-curve produces a visible stutter.
function triggerRipple(realId) {
  if (!state.motion.enabled) return;
  const neighbors = state.neighbors.get(realId);
  if (!neighbors) return;
  const now = performance.now();
  neighbors.forEach((nid) => {
    const existing = state.motion.pulses.get(nid);
    if (!existing || now - existing > MOTION_PULSE_MS * MOTION_PULSE_RETRIGGER) {
      state.motion.pulses.set(nid, now);
    }
  });
}

// Pulse multiplier for nodeReducer. Returns 1.0 when the node is
// not pulsing. Triangle-shaped curve (rises then falls) eased with
// smoothstep so the peak doesn't feel like a corner.
function pulseSizeMult(realId, nowMs) {
  const start = state.motion.pulses.get(realId);
  if (start === undefined) return 1;
  const t = (nowMs - start) / MOTION_PULSE_MS;
  if (t <= 0 || t >= 1) return 1;
  const wave = t < 0.5 ? smoothstep(t * 2) : smoothstep((1 - t) * 2);
  return 1 + MOTION_PULSE_PEAK * wave;
}

// ================================================================
// Create Renderer
// ================================================================

function createRenderer() {
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
  // state pulls back to give a sense of "settling into view."
  const camera = renderer.getCamera();
  camera.setState({ x: 0.5, y: 0.5, ratio: 1.5, angle: 0 });
  requestAnimationFrame(() => {
    camera.animate({ x: 0.5, y: 0.5, ratio: 1.3, angle: 0 }, { duration: 700 });
  });
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

  // Type filtering
  if (state.hiddenTypes.has(data.nodeType)) {
    res.hidden = true;
    return res;
  }

  // Search dimming
  if (state.searchQuery) {
    const matches = data.label.toLowerCase().includes(state.searchQuery);
    if (!matches) {
      res.color = COLORS.dimNode;
      res.label = "";
      res.zIndex = 0;
    } else {
      res.highlighted = true;
      res.zIndex = 2;
    }
  }

  // Hover / selection highlight
  const activeNode = state.hoveredNode || state.selectedNode;
  if (activeNode) {
    if (node === activeNode) {
      res.highlighted = true;
      res.size = data.size * 1.4;
      res.zIndex = 2;
    } else {
      const neighbors = state.neighbors.get(activeNode);
      if (neighbors && neighbors.has(node)) {
        res.zIndex = 1;
      } else {
        res.color = COLORS.dimNode;
        res.label = "";
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
  const res = { ...data };
  const activeNode = state.hoveredNode || state.selectedNode;

  if (activeNode) {
    const graph = state.graph;
    const source = graph.source(edge);
    const target = graph.target(edge);

    if (source === activeNode || target === activeNode) {
      res.color = COLORS.hoverEdge;
      res.size = Math.max(data.size, 1.5);
      res.zIndex = 1;
    } else {
      res.color = COLORS.dimEdge;
      res.zIndex = 0;
    }
  }

  // Hide edges connected to hidden nodes
  const graph = state.graph;
  const sourceType = graph.getNodeAttribute(graph.source(edge), "nodeType");
  const targetType = graph.getNodeAttribute(graph.target(edge), "nodeType");
  if (state.hiddenTypes.has(sourceType) || state.hiddenTypes.has(targetType)) {
    res.hidden = true;
  }

  return res;
}

// ================================================================
// Events
// ================================================================

function setupEvents() {
  const renderer = state.renderer;

  // Hover. Halos are concentric oversized siblings of real nodes;
  // remap halo → real so hovering the glow feels like hovering the
  // node. leaveNode only clears if the leaving node maps to the
  // currently-active hover — prevents a halo leave from clearing
  // hover state when the cursor has already entered the real node.
  renderer.on("enterNode", ({ node }) => {
    const realId = isHalo(node)
      ? state.graph.getNodeAttribute(node, "_haloOf")
      : node;
    if (!realId) return;
    state.hoveredNode = realId;
    document.body.style.cursor = "pointer";
    triggerRipple(realId);
    // When motion is on, the RAF loop already drives refresh every
    // frame. Without motion (reduced-motion preference), nudge sigma
    // explicitly so the dim/halo state updates.
    if (!state.motion.enabled) renderer.refresh();
  });

  renderer.on("leaveNode", ({ node }) => {
    const realId = isHalo(node)
      ? state.graph.getNodeAttribute(node, "_haloOf")
      : node;
    if (state.hoveredNode === realId) {
      state.hoveredNode = null;
      document.body.style.cursor = "default";
      renderer.refresh();
    }
  });

  // Click node → open sidebar
  renderer.on("clickNode", ({ node }) => {
    const realId = isHalo(node)
      ? state.graph.getNodeAttribute(node, "_haloOf")
      : node;
    if (realId) selectNode(realId);
  });

  // Click empty space → close sidebar
  renderer.on("clickStage", () => {
    closeSidebar();
  });

  // Sidebar close button
  document.getElementById("sidebar-close").addEventListener("click", closeSidebar);
}

// ================================================================
// Sidebar
// ================================================================

function selectNode(nodeId) {
  state.selectedNode = nodeId;
  state.renderer.refresh();
  scheduleUrlUpdate();

  // Fly-to node
  const nodePos = state.renderer.getNodeDisplayData(nodeId);
  if (nodePos) {
    state.renderer.getCamera().animate(
      { x: nodePos.x, y: nodePos.y, ratio: 0.35 },
      { duration: 400 },
    );
  }

  // Fetch entity detail and render sidebar
  fetch("/api/entity/" + encodeURIComponent(nodeId))
    .then((r) => r.json())
    .then((detail) => renderSidebar(detail))
    .catch(() => {
      document.getElementById("sidebar-content").innerHTML =
        '<p style="color:#ef4444">Failed to load entity details.</p>';
      document.getElementById("sidebar").classList.add("open");
    });
}

function closeSidebar() {
  state.selectedNode = null;
  document.getElementById("sidebar").classList.remove("open");
  state.renderer.refresh();
  scheduleUrlUpdate();
}

function renderSidebar(detail) {
  const e = detail.entity;
  let html = "";

  // Entity header
  html += '<div class="entity-name">' + escapeHtml(e.name) + "</div>";
  html += '<div class="entity-meta">' + e.type + " \u00b7 freq " + e.frequency + "</div>";
  html += '<div class="entity-description">' + escapeHtml(e.description) + "</div>";

  // Relations
  if (detail.relations.length > 0) {
    html += '<div class="section-title">Relations (' + detail.relations.length + ")</div>";
    for (const rel of detail.relations) {
      const arrow = rel.direction === "outgoing" ? "\u2192" : "\u2190";
      html +=
        '<div class="relation-item" data-target-id="' + escapeAttr(rel.targetId) + '">' +
        '<span class="relation-arrow">' + arrow + "</span>" +
        '<span class="relation-name">' + escapeHtml(rel.targetName) + "</span>" +
        '<span class="relation-type">' + rel.type + "</span>" +
        '<span class="relation-weight">' + rel.weight + "</span>" +
        "</div>";
    }
  }

  // Communities
  if (detail.communities.length > 0) {
    html += '<div class="section-title">Community</div>';
    for (const c of detail.communities) {
      const color = state.communityColors[c.id] || COLORS.nodeFallback;
      html +=
        '<div class="community-item">' +
        '<div class="community-dot" style="background:' + color + '"></div>' +
        '<div class="community-info">' +
        '<div class="community-title">' + escapeHtml(c.title) + "</div>" +
        '<div class="community-summary">' + escapeHtml(c.summary.slice(0, 150)) + "</div>" +
        "</div></div>";
    }
  }

  // Commits
  if (detail.recentCommits.length > 0) {
    html += '<div class="section-title">Recent Commits</div>';
    for (const c of detail.recentCommits) {
      html +=
        '<div class="commit-item">' +
        '<span class="commit-hash">' + c.hash + "</span>" +
        '<span class="commit-message">' + escapeHtml(c.message) + "</span>" +
        '<span class="commit-date">' + formatDate(c.date) + "</span>" +
        "</div>";
    }
  }

  // Timestamps
  html +=
    '<div class="entity-timestamps">' +
    "<span>First seen: " + e.firstSeen + "</span>" +
    "<span>Last seen: " + e.lastSeen + "</span>" +
    "</div>";

  const content = document.getElementById("sidebar-content");
  content.innerHTML = html;

  // Wire up relation click → navigate
  content.querySelectorAll(".relation-item").forEach((item) => {
    item.addEventListener("click", () => {
      const targetId = item.getAttribute("data-target-id");
      if (targetId && state.graph.hasNode(targetId)) {
        selectNode(targetId);
      }
    });
  });

  document.getElementById("sidebar").classList.add("open");
}

// ================================================================
// Search
// ================================================================

function setupSearch() {
  const input = document.getElementById("search-input");
  let debounceTimer = null;

  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      state.searchQuery = input.value.trim().toLowerCase();
      state.renderer.refresh();

      // Fly to first match
      if (state.searchQuery) {
        const graph = state.graph;
        let bestNode = null;
        let bestSize = 0;
        graph.forEachNode((node, attrs) => {
          if (
            attrs.label.toLowerCase().includes(state.searchQuery) &&
            !state.hiddenTypes.has(attrs.nodeType) &&
            attrs.size > bestSize
          ) {
            bestNode = node;
            bestSize = attrs.size;
          }
        });
        if (bestNode) {
          const pos = state.renderer.getNodeDisplayData(bestNode);
          if (pos) {
            state.renderer.getCamera().animate(
              { x: pos.x, y: pos.y, ratio: 0.5 },
              { duration: 300 },
            );
          }
        }
      }
    }, 300);
  });

  // Enter key → select first match
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && state.searchQuery) {
      const graph = state.graph;
      let bestNode = null;
      let bestSize = 0;
      graph.forEachNode((node, attrs) => {
        if (
          attrs.label.toLowerCase().includes(state.searchQuery) &&
          !state.hiddenTypes.has(attrs.nodeType) &&
          attrs.size > bestSize
        ) {
          bestNode = node;
          bestSize = attrs.size;
        }
      });
      if (bestNode) {
        selectNode(bestNode);
      }
    }
  });
}

// ================================================================
// Type chips — schema-driven from actual entity types in the graph.
// Avoids the bug where index.html lists 5 hardcoded types but the
// extractor schema can grow (CONCEPT, RISK, PROCESS, ...).
// Per /plan-eng-review A3 (compute client-side, zero API change).
// ================================================================

function setupTypeChips(graphData) {
  const container = document.getElementById("filter-chips");
  if (!container) return;
  container.innerHTML = "";

  const types = Array.from(new Set(graphData.nodes.map((n) => n.type))).sort();
  for (const type of types) {
    const chip = document.createElement("button");
    // Honor initial state restored from URL hash.
    const hidden = state.hiddenTypes.has(type);
    chip.className = "filter-chip" + (hidden ? "" : " active");
    chip.dataset.type = type;
    const color = COLORS.typeColors[type] || COLORS.nodeFallback;
    chip.style.setProperty("--chip-color", color);
    // PERSON → Person, TECHNOLOGY → Technology
    chip.textContent = type.charAt(0) + type.slice(1).toLowerCase();
    container.appendChild(chip);
  }
}

// ================================================================
// Filters
// ================================================================

function setupFilters() {
  document.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const type = chip.getAttribute("data-type");
      if (state.hiddenTypes.has(type)) {
        state.hiddenTypes.delete(type);
        chip.classList.add("active");
      } else {
        state.hiddenTypes.add(type);
        chip.classList.remove("active");
      }
      state.renderer.refresh();
      scheduleUrlUpdate();
    });
  });
}

// ================================================================
// URL state sync — debounced writes to history.replaceState so
// rapid filter toggles or search keystrokes don't spam the address
// bar (per /plan-eng-review P1, 200ms matches the search debounce).
// ================================================================

let urlUpdateTimer = null;
function scheduleUrlUpdate() {
  if (urlUpdateTimer) clearTimeout(urlUpdateTimer);
  urlUpdateTimer = setTimeout(writeUrl, 200);
}

function writeUrl() {
  urlUpdateTimer = null;
  const payload = serializeState({
    node: state.selectedNode,
    hide: Array.from(state.hiddenTypes),
  });
  const url = payload
    ? window.location.pathname + window.location.search + "#" + payload
    : window.location.pathname + window.location.search;
  history.replaceState(null, "", url);
}

// ================================================================
// Keyboard shortcuts
//   /         focus search input
//   Esc       close sidebar (or blur search if it's focused)
//   ↑↓←→     pan camera (proportional to current zoom)
//
// Bindings are skipped when the user is typing in any input field
// so they don't interfere with text entry.
// ================================================================

function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    const target = e.target;
    const isTyping =
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);

    // "/" focuses search — only when NOT already typing.
    if (e.key === "/" && !isTyping) {
      e.preventDefault();
      const search = document.getElementById("search-input");
      if (search) search.focus();
      return;
    }

    // Escape priority: search blur > overlay close > sidebar close.
    if (e.key === "Escape") {
      const searchEl = document.getElementById("search-input");
      if (document.activeElement === searchEl) {
        searchEl.blur();
      } else if (state.overlayOpen) {
        closeClusterOverlay();
      } else if (state.selectedNode) {
        closeSidebar();
      }
      return;
    }

    // Arrow keys pan camera (only when not typing and renderer exists).
    if (
      !isTyping &&
      state.renderer &&
      ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)
    ) {
      const camera = state.renderer.getCamera();
      const cs = camera.getState();
      const step = 0.1 * cs.ratio;
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowUp") dy = -step;
      else if (e.key === "ArrowDown") dy = step;
      else if (e.key === "ArrowLeft") dx = -step;
      else if (e.key === "ArrowRight") dx = step;
      e.preventDefault();
      camera.animate(
        { x: cs.x + dx, y: cs.y + dy, ratio: cs.ratio, angle: cs.angle },
        { duration: 180 },
      );
    }
  });
}

// ================================================================
// Theme — light / dark, persisted to localStorage, default from
// prefers-color-scheme. Sigma settings (defaultEdgeColor, labelColor)
// must be re-applied on theme change because sigma reads them once
// at renderer creation. Per-edge stored colors also need refresh.
// ================================================================

const THEME_KEY = "hald-theme";

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  COLORS = theme === "dark" ? COLORS_DARK : COLORS_LIGHT;
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

// ================================================================
// Cluster overlay (Explain this cluster)
// Click on a community label fetches /api/community/:id and renders
// title + summary + top entities. Entities are clickable (closes
// overlay, opens sidebar on the chosen node).
//
// Empty-state handling per /plan-eng-review C7: missing summary
// shows a clear "no summary" message rather than an empty modal.
// ================================================================

function setupClusterOverlay() {
  const overlay = document.getElementById("cluster-overlay");
  if (!overlay) return;

  // Click on community label opens the overlay.
  document.addEventListener("click", (e) => {
    const label = e.target.closest && e.target.closest(".community-label");
    if (!label) return;
    const id = label.dataset.communityId;
    if (!id) return;
    e.preventDefault();
    openClusterOverlay(id);
  });

  // Backdrop and close button.
  overlay.addEventListener("click", (e) => {
    if (
      e.target.classList.contains("cluster-overlay-backdrop") ||
      e.target.classList.contains("cluster-overlay-close")
    ) {
      closeClusterOverlay();
    }
  });
}

function openClusterOverlay(communityId) {
  const overlay = document.getElementById("cluster-overlay");
  const content = document.getElementById("cluster-content");
  if (!overlay || !content) return;

  content.innerHTML = '<div class="cluster-loading">Loading…</div>';
  overlay.removeAttribute("hidden");
  state.overlayOpen = true;

  fetch("/api/community/" + encodeURIComponent(communityId))
    .then((res) => {
      if (!res.ok) {
        content.innerHTML =
          '<div class="cluster-error">Community not found.</div>';
        return null;
      }
      return res.json();
    })
    .then((detail) => {
      if (detail) renderClusterOverlay(detail);
    })
    .catch((err) => {
      content.innerHTML =
        '<div class="cluster-error">Failed to load: ' +
        escapeHtml(err && err.message ? err.message : "unknown error") +
        "</div>";
    });
}

function renderClusterOverlay(detail) {
  const content = document.getElementById("cluster-content");
  if (!content) return;

  let html = "";
  html +=
    '<div class="cluster-title" id="cluster-title-anchor">' +
    escapeHtml(detail.title) +
    "</div>";

  if (detail.summary) {
    html +=
      '<div class="cluster-summary">' + escapeHtml(detail.summary) + "</div>";
  } else {
    html +=
      '<div class="cluster-summary cluster-empty">No summary available — re-run hald scan with summarization to generate one.</div>';
  }

  if (detail.topEntities && detail.topEntities.length > 0) {
    html += '<div class="cluster-section-title">Top entities</div>';
    html += '<div class="cluster-entities">';
    for (const e of detail.topEntities) {
      html +=
        '<div class="cluster-entity" data-entity-id="' +
        escapeAttr(e.id) +
        '">' +
        '<span class="cluster-entity-type">' +
        e.type +
        "</span>" +
        '<span class="cluster-entity-name">' +
        escapeHtml(e.name) +
        "</span>" +
        '<span class="cluster-entity-freq">' +
        e.frequency +
        "</span>" +
        "</div>";
    }
    html += "</div>";
  }

  content.innerHTML = html;

  // Wire entity click → close overlay and open the sidebar on that node.
  content.querySelectorAll(".cluster-entity").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-entity-id");
      if (id && state.graph && state.graph.hasNode(id)) {
        closeClusterOverlay();
        selectNode(id);
      }
    });
  });
}

function closeClusterOverlay() {
  const overlay = document.getElementById("cluster-overlay");
  if (overlay) overlay.setAttribute("hidden", "");
  state.overlayOpen = false;
}

function setupTheme() {
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

// ================================================================
// Community labels — floating divs at cluster centroids.
// Each label shows the LLM-generated title + summary on hover.
// Position is recomputed on every render via afterRender, batched in
// requestAnimationFrame for GPU-friendly transform updates (per P3).
// ================================================================

function setupCommunityLabels(graphData) {
  const container = document.getElementById("graph-container");
  let layer = document.getElementById("community-labels");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "community-labels";
    container.appendChild(layer);
  } else {
    layer.innerHTML = "";
  }

  state.communityLabels = [];
  for (const community of graphData.communities) {
    const members = graphData.nodes.filter((n) => n.communityId === community.id);
    // Skip singletons and pairs — too small to deserve a floating label
    // and they just add visual clutter on dense graphs.
    if (members.length < 3) continue;

    let sumX = 0;
    let sumY = 0;
    for (const n of members) {
      sumX += n.x;
      sumY += n.y;
    }
    const cx = sumX / members.length;
    const cy = sumY / members.length;

    const label = document.createElement("div");
    label.className = "community-label";
    label.style.color = community.color;
    label.dataset.communityId = community.id;
    label.textContent = community.title;

    const tip = document.createElement("div");
    tip.className = "community-tooltip";
    tip.textContent =
      community.summary ||
      "No summary available — re-run hald scan with summarization.";
    label.appendChild(tip);

    layer.appendChild(label);
    state.communityLabels.push({
      el: label,
      gx: cx,
      gy: cy,
      title: community.title,
      color: community.color,
    });
  }

  // Reposition on every render. RAF-batched to coalesce zoom/pan bursts.
  let raf = null;
  function update() {
    raf = null;
    const ratio = state.renderer.getCamera().getState().ratio;
    // Fade community labels at high zoom — node labels take over.
    const faded = ratio < 0.5;
    for (const l of state.communityLabels) {
      const pt = state.renderer.graphToViewport({ x: l.gx, y: l.gy });
      l.el.style.transform =
        "translate(" + pt.x + "px, " + pt.y + "px) translate(-50%, -50%)";
      if (faded) {
        l.el.setAttribute("data-faded", "true");
      } else {
        l.el.removeAttribute("data-faded");
      }
    }
  }
  function schedule() {
    if (!raf) raf = requestAnimationFrame(update);
  }
  state.renderer.on("afterRender", schedule);
  update();
}

// ================================================================
// Screenshot — composite sigma's canvas layers into a single PNG
// and download. Includes community labels rendered onto the canvas
// (they live as DOM divs in the live UI but need to be baked into
// the image for share-ability).
//
// Disabled when graph is empty (per /plan-eng-review C7).
// ================================================================

function captureScreenshotCanvas() {
  const canvases = state.renderer.getCanvases();
  // Sigma 3 layer names — composite in z-order.
  const layerOrder = ["edges", "nodes", "labels", "hovers", "edgeLabels"];
  const sample = canvases[layerOrder[0]] || Object.values(canvases)[0];
  if (!sample) return null;

  const out = document.createElement("canvas");
  out.width = sample.width;
  out.height = sample.height;
  const ctx = out.getContext("2d");
  if (!ctx) return null;

  // Background — match the body bg so transparency doesn't surprise viewers.
  const bg = getComputedStyle(document.body).backgroundColor || "#f8fafc";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, out.width, out.height);

  // Composite sigma layers
  for (const layer of layerOrder) {
    const c = canvases[layer];
    if (c) ctx.drawImage(c, 0, 0);
  }

  // Render community labels onto the canvas (DPR-aware)
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.font =
    'bold 13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const l of state.communityLabels || []) {
    const pt = state.renderer.graphToViewport({ x: l.gx, y: l.gy });
    // White halo (3 strokes for solid look)
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#ffffff";
    ctx.strokeText(l.title, pt.x, pt.y);
    // Title in the community's color
    ctx.fillStyle = l.color || COLORS.labelText;
    ctx.fillText(l.title, pt.x, pt.y);
  }
  ctx.restore();

  return out;
}

function setupScreenshot() {
  const btn = document.getElementById("btn-screenshot");
  if (!btn) return;

  // Empty graph → button stays disabled (HTML default already has it).
  if (!state.graph || state.graph.order === 0) {
    btn.disabled = true;
    return;
  }
  btn.disabled = false;

  btn.addEventListener("click", () => {
    const canvas = captureScreenshotCanvas();
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const date = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "hald-graph-" + date + ".png";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Defer revoke until next tick so the browser commits the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  });
}

// ================================================================
// Helpers
// ================================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;");
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) return "today";
    if (diffDays === 1) return "yesterday";
    if (diffDays < 30) return diffDays + "d ago";
    if (diffDays < 365) return Math.floor(diffDays / 30) + "mo ago";
    return Math.floor(diffDays / 365) + "y ago";
  } catch {
    return iso;
  }
}

// ================================================================
// Start
// ================================================================

init();
