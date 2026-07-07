// ================================================================
// Search + type-chip filters
// ================================================================

import { state, prefersReducedMotion } from "./state.js";
import { entityTypeLabel, entityTypeMark } from "./entity-types.js";
import { isHalo } from "./halo.js";
import { selectNode } from "./sidebar.js";
import { clearPath } from "./path-banner.js";
import { scheduleUrlUpdate } from "./url-sync.js";

// ================================================================
// Search
// ================================================================

// Lazily create the inline "0 matches for X" banner. Lives inside
// #graph-container at top-center so it doesn't fight the toolbar
// or sidebar for space. pointer-events:none so the canvas under it
// stays interactive.
function ensureSearchEmptyEl() {
  let el = document.getElementById("search-empty");
  if (el) return el;
  const container = document.getElementById("graph-container");
  el = document.createElement("div");
  el.id = "search-empty";
  el.className = "search-empty";
  el.style.display = "none";
  container.appendChild(el);
  return el;
}

export function setupSearch() {
  const input = document.getElementById("search-input");
  let debounceTimer = null;
  const emptyEl = ensureSearchEmptyEl();

  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      state.searchQuery = input.value.trim().toLowerCase();
      state.renderer.refresh();

      // Combined pass: pick the best (largest visible match) AND
      // count total matches — same iteration, two outputs. Empty
      // search clears both the empty-state banner and any prior fly.
      if (!state.searchQuery) {
        emptyEl.style.display = "none";
        return;
      }

      const graph = state.graph;
      let bestNode = null;
      let bestSize = 0;
      let matchCount = 0;
      graph.forEachNode((node, attrs) => {
        if (isHalo(node)) return;
        if (state.hiddenTypes.has(attrs.nodeType)) return;
        if (!attrs.label || !attrs.label.toLowerCase().includes(state.searchQuery)) return;
        matchCount++;
        if (attrs.size > bestSize) {
          bestNode = node;
          bestSize = attrs.size;
        }
      });

      if (matchCount === 0) {
        // Inline empty state — quoted query, dismissible by clearing
        // the input. Pointer-events disabled so it never blocks clicks
        // on the canvas behind it.
        emptyEl.textContent = `0 matches for "${input.value.trim()}"`;
        emptyEl.style.display = "block";
      } else {
        emptyEl.style.display = "none";
      }

      // Fly to first match (largest matching node). Reduced-motion users
      // get an instant jump (duration 0) instead of an animated fly-to.
      if (bestNode) {
        const pos = state.renderer.getNodeDisplayData(bestNode);
        if (pos) {
          state.renderer.getCamera().animate(
            { x: pos.x, y: pos.y, ratio: 0.5 },
            { duration: prefersReducedMotion() ? 0 : 300 },
          );
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

export function setupTypeChips(graphData) {
  const container = document.getElementById("filter-chips");
  if (!container) return;
  container.innerHTML = "";

  const types = Array.from(new Set(graphData.nodes.map((n) => n.type))).sort();
  const counts = new Map();
  for (const node of graphData.nodes) {
    counts.set(node.type, (counts.get(node.type) || 0) + 1);
  }

  for (const type of types) {
    const chip = document.createElement("button");
    // Honor initial state restored from URL hash.
    const hidden = state.hiddenTypes.has(type);
    const label = entityTypeLabel(type);
    chip.className = "filter-chip" + (hidden ? "" : " active");
    chip.dataset.type = type;
    chip.type = "button";
    chip.setAttribute("aria-pressed", hidden ? "false" : "true");
    chip.setAttribute(
      "aria-label",
      `${label} entities ${hidden ? "hidden" : "visible"}`,
    );

    const mark = document.createElement("span");
    mark.className = "filter-chip-mark";
    mark.textContent = entityTypeMark(type);

    const text = document.createElement("span");
    text.className = "filter-chip-label";
    text.textContent = label;

    const count = document.createElement("span");
    count.className = "filter-chip-count";
    count.textContent = String(counts.get(type) || 0);

    chip.append(mark, text, count);
    container.appendChild(chip);
  }
  updateFilterStatus();
}

// ================================================================
// Filters
// ================================================================

export function setupFilters() {
  document.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const type = chip.getAttribute("data-type");
      if (state.hiddenTypes.has(type)) {
        state.hiddenTypes.delete(type);
        chip.classList.add("active");
        chip.setAttribute("aria-pressed", "true");
        chip.setAttribute(
          "aria-label",
          `${entityTypeLabel(type)} entities visible`,
        );
      } else {
        state.hiddenTypes.add(type);
        chip.classList.remove("active");
        chip.setAttribute("aria-pressed", "false");
        chip.setAttribute(
          "aria-label",
          `${entityTypeLabel(type)} entities hidden`,
        );
      }
      updateFilterStatus();
      // If the active path runs through a now-hidden type, the
      // visualization would render a broken thread (some hops gone,
      // banner still claims they're there). Clear the path on filter
      // change rather than show a misleading half-view; user can
      // re-trace with the new filter set if they still want to.
      if (state.path.active && pathTouchesHiddenType()) {
        clearPath();
      }
      state.renderer.refresh();
      scheduleUrlUpdate();
    });
  });
}

function pathTouchesHiddenType() {
  if (!state.path.active || !state.graph) return false;
  for (const id of state.path.nodes) {
    if (!state.graph.hasNode(id)) continue;
    const t = state.graph.getNodeAttribute(id, "nodeType");
    if (state.hiddenTypes.has(t)) return true;
  }
  return false;
}

export function filterStateLabel(visible, total) {
  if (total <= 0) return "No entity types";
  if (visible === total) return `All ${total} types visible`;
  if (visible === 0) return "No types visible";
  return `${visible} of ${total} types visible`;
}

function updateFilterStatus() {
  const status = document.getElementById("filter-status");
  if (!status) return;
  const chips = Array.from(document.querySelectorAll(".filter-chip"));
  const total = chips.length;
  const visible = chips.filter((chip) => chip.classList.contains("active")).length;
  status.textContent = filterStateLabel(visible, total);
  status.dataset.state =
    visible === total ? "all" : visible === 0 ? "none" : "partial";
}
