/* global graphology, Sigma */

// ================================================================
// Thin orchestrator. The graph viz is split into native ES modules
// (state, colors, halo, motion, path, renderer, curved-edges, sidebar,
// search-filters, events, url-sync, keyboard, theme, cluster-overlay,
// community-labels, screenshot, zoom-density). This file imports them,
// runs init(), and wires the top-level boot sequence. Each extracted
// module owns its own section of behavior and exports its functions.
//
// Browser-only ESM, no build step: the viz server serves every file
// under public/ at /assets/<name>, and modules import each other via
// relative './name.js'. index.html loads /assets/app.js as type=module.
// ================================================================

import { parseHash } from "./url-state.js";
import { state } from "./state.js";
import { renderStats, selectNode } from "./sidebar.js";
import { buildGraph } from "./graph-builder.js";
import { createRenderer } from "./renderer.js";
import { setupTypeChips, setupSearch, setupFilters } from "./search-filters.js";
import { setupEvents } from "./events.js";
import { setupCommunityLabels } from "./community-labels.js";
import { setupScreenshot } from "./screenshot.js";
import { setupLegend } from "./legend.js";
import { setupShortcuts } from "./shortcuts.js";
import { setupKeyboardShortcuts } from "./keyboard.js";
import { setupTheme } from "./theme.js";
import { setupClusterOverlay } from "./cluster-overlay.js";
import { setupZoomDensity } from "./zoom-density.js";
import { setupCurvedEdges } from "./curved-edges.js";
import { startMotionLoop } from "./motion.js";

// ================================================================
// Init
// ================================================================

// Probe for WebGL support. Sigma needs a WebGL (or WebGL2) context to
// render; some browsers (headless, locked-down, or with acceleration
// disabled) ship the globals but can't produce a context. We
// distinguish "engine missing" from "engine present, GPU unavailable"
// so the error tells the viewer what to actually do about it.
function hasWebGL() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl") || canvas.getContext("webgl2"),
    );
  } catch (_e) {
    return false;
  }
}

async function init() {
  const loadingEl = document.getElementById("loading");

  if (typeof graphology === "undefined" || typeof Sigma === "undefined") {
    loadingEl.textContent =
      "Failed to load the graph engine (graphology / Sigma).";
    loadingEl.classList.add("error");
    return;
  }

  if (!hasWebGL()) {
    loadingEl.textContent =
      "This browser can't render the graph: WebGL is unavailable. " +
      "Try a hardware-accelerated browser.";
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
    setupLegend();
    setupShortcuts();
    setupKeyboardShortcuts();
    setupTheme();
    setupClusterOverlay();
    setupZoomDensity();
    // Curved edges layer — must come AFTER createRenderer so sigma's
    // canvases exist (we insert ours as a sibling at the front) and
    // BEFORE motion starts so the first breathing frame already has
    // curves drawn.
    setupCurvedEdges();
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
// Start
// ================================================================

init();
