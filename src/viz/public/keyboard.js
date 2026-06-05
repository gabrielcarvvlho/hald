// ================================================================
// Keyboard shortcuts
//   /         focus search input
//   Esc       close sidebar (or blur search if it's focused)
//   ↑↓←→     pan camera (proportional to current zoom)
//
// Bindings are skipped when the user is typing in any input field
// so they don't interfere with text entry.
// ================================================================

import { state } from "./state.js";
import { clearPath } from "./path-banner.js";
import { closeSidebar } from "./sidebar.js";
import { closeClusterOverlay } from "./cluster-overlay.js";

export function setupKeyboardShortcuts() {
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

    // Escape priority: search blur > overlay close > path clear > sidebar close.
    // Path is dismissed before sidebar so the user can clear the
    // highlight without losing the entity panel they're reading.
    if (e.key === "Escape") {
      const searchEl = document.getElementById("search-input");
      if (document.activeElement === searchEl) {
        searchEl.blur();
      } else if (state.overlayOpen) {
        closeClusterOverlay();
      } else if (state.path.active) {
        clearPath();
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
