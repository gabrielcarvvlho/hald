// ================================================================
// Curved edges — 2D canvas overlay below sigma's WebGL
// ================================================================
//
// Why an overlay instead of a sigma EdgeProgram subclass:
//   - The vendored sigma is a minified UMD; subclassing its internal
//     program base class is brittle across versions.
//   - @sigma/edge-curve doesn't ship a UMD we can drop-in; bundling
//     it would add build complexity for one feature.
//   - A 2D canvas under sigma's WebGL canvas costs ~ms per frame for
//     <2k edges, gives full control over curve shape, and keeps the
//     WebGL pipeline doing what it does best (nodes + halos).
//
// Layering: our canvas is inserted as the FIRST child of
// #graph-container. Sigma's canvases are added after, so they paint
// ON TOP of ours. Our curves show through the transparent regions
// of sigma's canvases — i.e., everywhere except where nodes are
// drawn. Effect: nodes naturally cover edge endpoints.
//
// Sigma's own edge rendering is disabled by edgeReducer returning
// hidden:true for every edge. We replicate dim/hover/type-filter
// logic in this drawer.

import { state } from "./state.js";
import { getColors } from "./colors.js";
import { isHalo } from "./halo.js";

const EDGE_CURVE_AMOUNT = 0.12;       // sagitta as fraction of chord length
const EDGE_CURVE_MIN_LEN = 8;         // below this (in screen px), draw straight

// ----------------------------------------------------------------
// Dirty-flag cache. drawCurvedEdges() runs on every sigma afterRender —
// which, while the breathing RAF loop is running, is every frame. The
// curve geometry only changes when the camera moves, a node moves, or
// the dim/hover/path/filter selection changes. We cache a signature of
// everything that affects the overlay and SKIP the redraw only when the
// signature is byte-identical to the last draw.
//
// CONSERVATIVE BY DESIGN — correctness beats perf, a stale overlay is a
// visible bug. We REDRAW (never skip) whenever ANY of these is true:
//   1. Motion is enabled. Breathing drifts node positions every frame,
//      so edge endpoints move continuously — the overlay is never stable.
//      (When motion is off — reduced-motion — afterRender only fires on
//      explicit refresh()es, so skipping between them is safe.)
//   2. Camera state (x, y, ratio, angle) changed — pan/zoom/rotate.
//   3. Active node changed (hover or selection) — alters dim/highlight.
//   4. Path active-flag or membership-version changed.
//   5. The hidden-types filter set changed (size is a cheap proxy; the
//      filter handler always refreshes, which re-runs us anyway).
//   6. Canvas size changed (resize) — geometry maps to new pixels.
//   7. Theme changed — applyTheme() recolors every edge then refresh()es;
//      the data-theme attribute captures that so the overlay doesn't keep
//      the old palette's edge colors.
// When in any doubt we fall through and redraw.
let lastSig = null;

function computeSignature(canvas) {
  const cam = state.renderer.getCamera().getState();
  const activeNode = state.hoveredNode || state.selectedNode;
  // path.nodeSet/edgeSet are rebuilt on every path change; using their
  // sizes + endpoints captures membership churn without serializing sets.
  const p = state.path;
  const theme =
    (typeof document !== "undefined" &&
      document.documentElement &&
      document.documentElement.dataset.theme) ||
    "";
  return [
    cam.x,
    cam.y,
    cam.ratio,
    cam.angle,
    activeNode || "",
    p.active ? 1 : 0,
    p.fromId || "",
    p.toId || "",
    p.nodeSet.size,
    p.edgeSet.size,
    state.hiddenTypes.size,
    state.searchQuery,
    canvas.width,
    canvas.height,
    theme,
  ].join("|");
}

function ensureEdgeOverlay() {
  let canvas = document.getElementById("edge-overlay");
  if (canvas) return canvas;
  const container = document.getElementById("graph-container");
  canvas = document.createElement("canvas");
  canvas.id = "edge-overlay";
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.pointerEvents = "none";
  // Z-index 0 + first-child DOM position keeps us under sigma's
  // canvases regardless of what z-indexes sigma assigns its layers.
  canvas.style.zIndex = "0";
  // Insert at the front so sigma's canvases (added after) stack on top.
  container.insertBefore(canvas, container.firstChild);
  return canvas;
}

function sizeEdgeOverlay(canvas) {
  const container = canvas.parentElement;
  if (!container) return;
  const dpr = window.devicePixelRatio || 1;
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

export function drawCurvedEdges() {
  const COLORS = getColors();
  const canvas = ensureEdgeOverlay();
  sizeEdgeOverlay(canvas);
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;

  if (!state.graph || !state.renderer) return;

  // Dirty-flag gate. Skip the full redraw ONLY when motion is off AND the
  // overlay signature is unchanged since the last draw (see computeSignature
  // for the exact invalidation conditions). When motion is on, node
  // positions drift every frame, so we always redraw. Skipping here means
  // NOT clearing — the previously-painted curves stay on screen, which is
  // correct precisely because nothing that affects them changed.
  if (!state.motion.enabled) {
    const sig = computeSignature(canvas);
    if (sig === lastSig) return;
    lastSig = sig;
  } else {
    // Motion drives continuous redraws; invalidate the cache so the first
    // frame after motion stops always does a fresh draw.
    lastSig = null;
  }

  // Clear in CSS pixels (transform is DPR-scaled).
  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;
  ctx.clearRect(0, 0, cssW, cssH);

  const g = state.graph;
  const renderer = state.renderer;
  const activeNode = state.hoveredNode || state.selectedNode;
  const pathActive = state.path.active;

  ctx.lineCap = "round";

  // Inline draw helper — used for both passes. Captures ctx + renderer
  // via closure so we don't re-resolve them per edge.
  function drawOne(srcAttrs, tgtAttrs, color, size) {
    const sP = renderer.graphToViewport({ x: srcAttrs.x, y: srcAttrs.y });
    const tP = renderer.graphToViewport({ x: tgtAttrs.x, y: tgtAttrs.y });
    const dx = tP.x - sP.x;
    const dy = tP.y - sP.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.beginPath();
    ctx.moveTo(sP.x, sP.y);
    if (len < EDGE_CURVE_MIN_LEN) {
      ctx.lineTo(tP.x, tP.y);
    } else {
      // Quadratic bezier with perpendicular offset (90° CCW from
      // S→T direction). Sagitta is EDGE_CURVE_AMOUNT × chord len.
      const px = -dy / len;
      const py = dx / len;
      const cx = (sP.x + tP.x) / 2 + px * len * EDGE_CURVE_AMOUNT;
      const cy = (sP.y + tP.y) / 2 + py * len * EDGE_CURVE_AMOUNT;
      ctx.quadraticCurveTo(cx, cy, tP.x, tP.y);
    }
    ctx.stroke();
  }

  // Pass 1: non-path edges. When path is active, these are dimmed
  // hard so the highlighted thread reads cleanly.
  g.forEachEdge((edge, attrs, src, tgt, srcAttrs, tgtAttrs) => {
    if (isHalo(src) || isHalo(tgt)) return;
    if (
      state.hiddenTypes.has(srcAttrs.nodeType) ||
      state.hiddenTypes.has(tgtAttrs.nodeType)
    ) {
      return;
    }
    if (pathActive && state.path.edgeSet.has(edge)) return; // drawn in pass 2

    let color = attrs.color;
    let size = attrs.size || 1;

    if (pathActive) {
      // Path mode dominant — every non-path edge dims to the same
      // value so the amber thread doesn't compete with hover dim.
      color = COLORS.dimEdge;
    } else if (activeNode) {
      if (src === activeNode || tgt === activeNode) {
        color = COLORS.hoverEdge;
        size = Math.max(size, 1.5);
      } else {
        color = COLORS.dimEdge;
      }
    }

    drawOne(srcAttrs, tgtAttrs, color, size);
  });

  // Pass 2: path edges drawn ON TOP, in amber, thicker. Skipped
  // entirely when no path is active.
  if (pathActive) {
    g.forEachEdge((edge, attrs, src, tgt, srcAttrs, tgtAttrs) => {
      if (!state.path.edgeSet.has(edge)) return;
      if (isHalo(src) || isHalo(tgt)) return;
      if (
        state.hiddenTypes.has(srcAttrs.nodeType) ||
        state.hiddenTypes.has(tgtAttrs.nodeType)
      ) {
        return;
      }
      // Path edge thickness: 2× baseline with a hard cap so heavy
      // edges don't become absurd lines. Min floor 1.5 ensures even
      // the lightest connection reads as a deliberate thread.
      const size = Math.min(5, Math.max(attrs.size || 1, 1.5) * 2);
      drawOne(srcAttrs, tgtAttrs, COLORS.pathEdge, size);
    });
  }
}

export function setupCurvedEdges() {
  if (!state.renderer) return;
  ensureEdgeOverlay();
  state.renderer.on("afterRender", drawCurvedEdges);
  // Initial draw so curves appear before sigma's intro animation
  // first frame fires afterRender.
  drawCurvedEdges();
}
