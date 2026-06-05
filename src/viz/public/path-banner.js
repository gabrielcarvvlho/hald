// ================================================================
// Path highlighting — cmd/ctrl-click two nodes to trace shortest path
// ================================================================
//
// UX: click selects a node. Cmd-click (mac) / Ctrl-click (other) on
// a SECOND node while one is already selected triggers a BFS from the
// first to the second. The path is rendered as:
//   - Path nodes lifted (size boost, forceLabel) and undimmed
//   - Path edges in amber, drawn AFTER non-path edges so they sit on top
//   - Non-path nodes/edges dimmed so the thread reads cleanly
//   - Floating banner at top with clickable hop list + close
//
// The BFS itself lives in the pure path.js module; this module owns
// the stateful set/clear lifecycle and the floating banner DOM.

import { state } from "./state.js";
import {
  findShortestPath,
  buildPathEdgeSet,
  buildPathEdgeTypes,
} from "./path.js";
import { selectNode } from "./sidebar.js";

const PATH_AUTO_DISMISS_ERROR_MS = 2500;

export function clearPath() {
  if (state.path.errorTimerId !== null) {
    clearTimeout(state.path.errorTimerId);
    state.path.errorTimerId = null;
  }
  state.path.active = false;
  state.path.nodes = [];
  state.path.edgeTypes = [];
  state.path.nodeSet = new Set();
  state.path.edgeSet = new Set();
  state.path.fromId = null;
  state.path.toId = null;
  hidePathBanner();
  if (state.renderer) state.renderer.refresh();
}

export function setPath(srcId, tgtId) {
  const nodes = findShortestPath(state.graph, srcId, tgtId);
  if (!nodes || nodes.length < 2) {
    showPathBannerError(srcId, tgtId);
    return false;
  }
  if (state.path.errorTimerId !== null) {
    clearTimeout(state.path.errorTimerId);
    state.path.errorTimerId = null;
  }
  state.path.active = true;
  state.path.nodes = nodes;
  state.path.edgeTypes = buildPathEdgeTypes(state.graph, nodes);
  state.path.nodeSet = new Set(nodes);
  state.path.edgeSet = buildPathEdgeSet(state.graph, nodes);
  state.path.fromId = srcId;
  state.path.toId = tgtId;
  showPathBanner(nodes);
  state.renderer.refresh();
  return true;
}

// ================================================================
// Path banner — floating top-of-canvas summary with clickable hops
// ================================================================

function ensurePathBanner() {
  let banner = document.getElementById("path-banner");
  if (banner) return banner;
  const container = document.getElementById("graph-container");
  banner = document.createElement("div");
  banner.id = "path-banner";
  banner.className = "path-banner";
  banner.hidden = true;
  banner.innerHTML =
    '<div class="path-banner-content"></div>' +
    '<button class="path-banner-close" aria-label="Clear path" title="Clear path (Esc)">&times;</button>';
  banner.querySelector(".path-banner-close").addEventListener("click", clearPath);
  container.appendChild(banner);
  return banner;
}

function nodeLabelOrId(id) {
  if (state.graph && state.graph.hasNode(id)) {
    const lbl = state.graph.getNodeAttribute(id, "label");
    if (lbl) return lbl;
  }
  return id;
}

function showPathBanner(pathNodes) {
  const banner = ensurePathBanner();
  const content = banner.querySelector(".path-banner-content");
  content.innerHTML = "";
  const len = pathNodes.length;

  for (let i = 0; i < len; i++) {
    const id = pathNodes[i];
    const isEnd = i === 0 || i === len - 1;
    const step = document.createElement("span");
    step.className = "path-banner-step" + (isEnd ? " is-endpoint" : "");
    step.textContent = nodeLabelOrId(id);
    step.title = nodeLabelOrId(id);
    step.addEventListener("click", () => {
      // Banner clicks bypass the canvas click handler, so calling
      // selectNode directly preserves the path mode (only the
      // modifier-click handler in setupEvents calls clearPath).
      selectNode(id);
    });
    content.appendChild(step);

    if (i < len - 1) {
      // Connector between hops shows the relation type — turns the
      // path from "graph theory" into "story": Alice ─authored→
      // src/extractor ─uses→ src/store. The edge type comes from the
      // extractor's relation classification (AUTHORED, USES,
      // DEPENDS_ON, CO_CHANGED, DECIDED, ...). When the type is
      // missing we fall back to a plain arrow so we never show a
      // broken connector.
      const arrow = document.createElement("span");
      arrow.className = "path-banner-arrow";
      const edgeType = state.path.edgeTypes[i];
      if (edgeType) {
        const label = document.createElement("span");
        label.className = "path-banner-edgetype";
        label.textContent = edgeType.toLowerCase().replace(/_/g, " ");
        arrow.appendChild(label);
        arrow.appendChild(document.createTextNode("→"));
      } else {
        arrow.textContent = "→";
      }
      content.appendChild(arrow);
    }
  }

  const meta = document.createElement("span");
  meta.className = "path-banner-meta";
  const hops = len - 1;
  meta.textContent = "· " + hops + " hop" + (hops === 1 ? "" : "s");
  content.appendChild(meta);

  banner.classList.remove("is-error");
  banner.hidden = false;
}

function showPathBannerError(srcId, tgtId) {
  const banner = ensurePathBanner();
  const content = banner.querySelector(".path-banner-content");
  content.innerHTML = "";
  const msg = document.createElement("span");
  msg.className = "path-banner-step is-error";
  msg.textContent =
    'No connection between "' +
    nodeLabelOrId(srcId) +
    '" and "' +
    nodeLabelOrId(tgtId) +
    '"';
  content.appendChild(msg);
  banner.classList.add("is-error");
  banner.hidden = false;

  if (state.path.errorTimerId !== null) clearTimeout(state.path.errorTimerId);
  state.path.errorTimerId = setTimeout(() => {
    state.path.errorTimerId = null;
    // Only auto-dismiss the error if no real path got set in the
    // meantime (defensive — user could cmd-click again before timer).
    if (!state.path.active) hidePathBanner();
  }, PATH_AUTO_DISMISS_ERROR_MS);
}

function hidePathBanner() {
  const banner = document.getElementById("path-banner");
  if (banner) {
    banner.hidden = true;
    banner.classList.remove("is-error");
  }
}
