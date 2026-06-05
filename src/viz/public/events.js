// ================================================================
// Events — hover, click, path-trace, stage clicks, sidebar close
// ================================================================

import { state } from "./state.js";
import { isHalo } from "./halo.js";
import { triggerRipple } from "./motion.js";
import { setPath, clearPath } from "./path-banner.js";
import { selectNode, closeSidebar } from "./sidebar.js";

export function setupEvents() {
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

  // Click node → select, OR cmd/ctrl-click → trace shortest path from
  // the previously selected node to this one. Sigma 3 wraps the native
  // event under `event.original`. On macOS, ctrl-click is right-click
  // (a different sigma event), so accepting both metaKey and ctrlKey
  // means mac users use ⌘ and linux/win users use Ctrl, both safe.
  renderer.on("clickNode", (payload) => {
    const node = payload && payload.node;
    if (!node) return;
    const original = payload.event && payload.event.original;
    const isMod = !!(original && (original.metaKey || original.ctrlKey));

    const realId = isHalo(node)
      ? state.graph.getNodeAttribute(node, "_haloOf")
      : node;
    if (!realId) return;

    if (isMod && state.selectedNode && state.selectedNode !== realId) {
      setPath(state.selectedNode, realId);
      return;
    }

    // Regular click — clear any active path then select normally.
    if (state.path.active) clearPath();
    selectNode(realId);
  });

  // Click empty space → clear path + close sidebar (deselect-all gesture).
  renderer.on("clickStage", () => {
    if (state.path.active) clearPath();
    closeSidebar();
  });

  // Sidebar close button
  document.getElementById("sidebar-close").addEventListener("click", closeSidebar);
}
