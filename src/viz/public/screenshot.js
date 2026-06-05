// ================================================================
// Screenshot — composite sigma's canvas layers into a single PNG
// and download. Includes community labels rendered onto the canvas
// (they live as DOM divs in the live UI but need to be baked into
// the image for share-ability).
//
// Disabled when graph is empty (per /plan-eng-review C7).
// ================================================================

import { state } from "./state.js";
import { getColors } from "./colors.js";
import { drawCurvedEdges } from "./curved-edges.js";

// Transient toast confirmation. The #toast element is aria-live=polite,
// so updating its text also announces to screen readers. We clear any
// pending hide timer first so rapid saves don't flicker.
let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  // Force reflow so re-triggering the fade-in transition works even
  // when the toast was already visible from a previous save.
  void toast.offsetWidth;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("is-visible");
    // Hide after the fade-out so it leaves the accessibility tree.
    setTimeout(() => {
      toast.hidden = true;
    }, 200);
  }, 2200);
}

function captureScreenshotCanvas() {
  const COLORS = getColors();
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

  // Composite the curved-edges overlay BEFORE sigma's layers so
  // curves sit under nodes. Force a re-draw first to ensure the
  // overlay matches current camera state at capture time.
  drawCurvedEdges();
  const overlay = document.getElementById("edge-overlay");
  if (overlay) ctx.drawImage(overlay, 0, 0, out.width, out.height);

  // Composite sigma layers
  for (const layer of layerOrder) {
    const c = canvases[layer];
    if (c) ctx.drawImage(c, 0, 0);
  }

  // Render community labels onto the canvas using the DOM label's
  // current position (which is computed from the topmost cluster
  // member each frame). Reading getBoundingClientRect keeps the
  // screenshot in lockstep with the live UI no matter how the
  // positioning logic evolves.
  const dpr = window.devicePixelRatio || 1;
  const container = document.getElementById("graph-container");
  const cRect = container ? container.getBoundingClientRect() : { left: 0, top: 0 };
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.font =
    'bold 13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const l of state.communityLabels || []) {
    if (!l.el || l.el.style.display === "none") continue;
    const r = l.el.getBoundingClientRect();
    const cx = r.left + r.width / 2 - cRect.left;
    const cy = r.top + r.height / 2 - cRect.top;
    // White halo so titles read against any cluster color.
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#ffffff";
    ctx.strokeText(l.title, cx, cy);
    ctx.fillStyle = l.color || COLORS.labelText;
    ctx.fillText(l.title, cx, cy);
  }
  ctx.restore();

  return out;
}

export function setupScreenshot() {
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
      showToast("Saved PNG");
      // Defer revoke until next tick so the browser commits the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  });
}
