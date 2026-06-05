// ================================================================
// Zoom-driven label density
// ================================================================
// Sigma's labelRenderedSizeThreshold gates which nodes draw a label.
// Default 12px means only the top-3 force-labeled anchors show under
// normal zoom — the rest reveal on hover. Tying threshold to the
// camera ratio gives Obsidian-style progressive disclosure: zoom in,
// more labels appear; zoom out, only the cluster names remain.
//
// thresholdForRatio + ZOOM_LABEL_BUCKETS are pure (no DOM/Sigma) so
// they import cleanly into vitest. setupZoomDensity wires the camera.

import { state } from "./state.js";

export const ZOOM_LABEL_BUCKETS = [
  // [maxRatio, threshold]  — first bucket whose ratio matches wins
  [0.35, 3],   // very zoomed in: label nearly every node
  [0.55, 6],
  [0.85, 9],
  [1.30, 12],  // default desktop zoom
  [2.00, 20],  // zooming out: fewer labels
  [Infinity, 999], // far out: communities only
];

export function thresholdForRatio(ratio) {
  for (const [max, t] of ZOOM_LABEL_BUCKETS) {
    if (ratio < max) return t;
  }
  return 999;
}

export function setupZoomDensity() {
  if (!state.renderer) return;
  const camera = state.renderer.getCamera();
  let lastThreshold = -1;

  const apply = () => {
    const r = camera.getState().ratio;
    const t = thresholdForRatio(r);
    if (t !== lastThreshold) {
      state.renderer.setSetting("labelRenderedSizeThreshold", t);
      lastThreshold = t;
    }
  };

  camera.on("updated", apply);
  apply(); // initial
}
