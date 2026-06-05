// ================================================================
// Sidebar — entity detail panel + stats header
// ================================================================

import { state, prefersReducedMotion } from "./state.js";
import { getColors } from "./colors.js";
import { scheduleUrlUpdate } from "./url-sync.js";
import { escapeHtml, escapeAttr, formatDate } from "./dom-utils.js";

// ================================================================
// Stats
// ================================================================

export function renderStats(stats) {
  const el = document.getElementById("stats-text");
  const parts = [];
  if (stats.entities) parts.push(stats.entities + " entities");
  if (stats.relations) parts.push(stats.relations + " relations");
  if (stats.communities) parts.push(stats.communities + " communities");
  el.textContent = parts.join(" · ");
}

export function selectNode(nodeId) {
  state.selectedNode = nodeId;
  state.renderer.refresh();
  scheduleUrlUpdate();

  // Fly-to node. Reduced-motion users get an instant jump (duration 0).
  const nodePos = state.renderer.getNodeDisplayData(nodeId);
  if (nodePos) {
    state.renderer.getCamera().animate(
      { x: nodePos.x, y: nodePos.y, ratio: 0.35 },
      { duration: prefersReducedMotion() ? 0 : 400 },
    );
  }

  // Fetch entity detail and render sidebar
  fetch("/api/entity/" + encodeURIComponent(nodeId))
    .then((r) => r.json())
    .then((detail) => renderSidebar(detail))
    .catch(() => {
      document.getElementById("sidebar-content").innerHTML =
        '<p style="color:#ef4444">Failed to load entity details.</p>';
      document.getElementById("sidebar").classList.add("open");
    });
}

export function closeSidebar() {
  state.selectedNode = null;
  document.getElementById("sidebar").classList.remove("open");
  state.renderer.refresh();
  scheduleUrlUpdate();
}

function renderSidebar(detail) {
  const COLORS = getColors();
  const e = detail.entity;
  let html = "";

  // Entity header
  html += '<div class="entity-name">' + escapeHtml(e.name) + "</div>";
  html += '<div class="entity-meta">' + e.type + " · freq " + e.frequency + "</div>";
  html += '<div class="entity-description">' + escapeHtml(e.description) + "</div>";

  // Relations
  if (detail.relations.length > 0) {
    html += '<div class="section-title">Relations (' + detail.relations.length + ")</div>";
    for (const rel of detail.relations) {
      const arrow = rel.direction === "outgoing" ? "→" : "←";
      html +=
        '<div class="relation-item" data-target-id="' + escapeAttr(rel.targetId) + '">' +
        '<span class="relation-arrow">' + arrow + "</span>" +
        '<span class="relation-name">' + escapeHtml(rel.targetName) + "</span>" +
        '<span class="relation-type">' + rel.type + "</span>" +
        '<span class="relation-weight">' + rel.weight + "</span>" +
        "</div>";
    }
  }

  // Communities
  if (detail.communities.length > 0) {
    html += '<div class="section-title">Community</div>';
    for (const c of detail.communities) {
      const color = state.communityColors[c.id] || COLORS.nodeFallback;
      html +=
        '<div class="community-item">' +
        '<div class="community-dot" style="background:' + color + '"></div>' +
        '<div class="community-info">' +
        '<div class="community-title">' + escapeHtml(c.title) + "</div>" +
        '<div class="community-summary">' + escapeHtml(c.summary.slice(0, 150)) + "</div>" +
        "</div></div>";
    }
  }

  // Commits
  if (detail.recentCommits.length > 0) {
    html += '<div class="section-title">Recent Commits</div>';
    for (const c of detail.recentCommits) {
      html +=
        '<div class="commit-item">' +
        '<span class="commit-hash">' + c.hash + "</span>" +
        '<span class="commit-message">' + escapeHtml(c.message) + "</span>" +
        '<span class="commit-date">' + formatDate(c.date) + "</span>" +
        "</div>";
    }
  }

  // Timestamps
  html +=
    '<div class="entity-timestamps">' +
    "<span>First seen: " + e.firstSeen + "</span>" +
    "<span>Last seen: " + e.lastSeen + "</span>" +
    "</div>";

  const content = document.getElementById("sidebar-content");
  content.innerHTML = html;

  // Wire up relation click → navigate
  content.querySelectorAll(".relation-item").forEach((item) => {
    item.addEventListener("click", () => {
      const targetId = item.getAttribute("data-target-id");
      if (targetId && state.graph.hasNode(targetId)) {
        selectNode(targetId);
      }
    });
  });

  document.getElementById("sidebar").classList.add("open");
}
