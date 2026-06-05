// ================================================================
// Cluster overlay (Explain this cluster)
// Click on a community label fetches /api/community/:id and renders
// title + summary + top entities. Entities are clickable (closes
// overlay, opens sidebar on the chosen node).
//
// Empty-state handling per /plan-eng-review C7: missing summary
// shows a clear "no summary" message rather than an empty modal.
// ================================================================

import { state } from "./state.js";
import { escapeHtml, escapeAttr } from "./dom-utils.js";
import { selectNode } from "./sidebar.js";

export function setupClusterOverlay() {
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

export function closeClusterOverlay() {
  const overlay = document.getElementById("cluster-overlay");
  if (overlay) overlay.setAttribute("hidden", "");
  state.overlayOpen = false;
}
