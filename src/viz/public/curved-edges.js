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
  // Clear in CSS pixels (transform is DPR-scaled).
  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;
  ctx.clearRect(0, 0, cssW, cssH);

  if (!state.graph || !state.renderer) return;
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
