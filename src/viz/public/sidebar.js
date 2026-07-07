// ================================================================
// Sidebar inspector - overview, entity detail, and community detail
// ================================================================

import { state, prefersReducedMotion } from "./state.js";
import { getColors } from "./colors.js";
import { scheduleUrlUpdate } from "./url-sync.js";
import { escapeHtml, escapeAttr, formatDate } from "./dom-utils.js";

const OVERVIEW_COMMUNITY_LIMIT = 5;
const ENTITY_RELATION_LIMIT = 8;
const ENTITY_COMMIT_LIMIT = 6;

// ================================================================
// Stats
// ================================================================

export function renderStats(stats) {
  const el = document.getElementById("stats-text");
  const parts = [];
  if (stats.entities) parts.push(stats.entities + " entities");
  if (stats.relations) parts.push(stats.relations + " relations");
  if (stats.communities) parts.push(stats.communities + " communities");
  el.textContent = parts.join(" | ");
}

// ================================================================
// Pure helpers for tests and state transitions
// ================================================================

export function nextInspectorSelection(_current, action) {
  if (action && action.type === "node" && action.id) {
    return { selectedNode: action.id, selectedCommunity: null };
  }
  if (action && action.type === "community" && action.id) {
    return { selectedNode: null, selectedCommunity: action.id };
  }
  return { selectedNode: null, selectedCommunity: null };
}

export function buildOverviewModel(graphData, statsData) {
  const nodes = graphData && Array.isArray(graphData.nodes) ? graphData.nodes : [];
  const edges = graphData && Array.isArray(graphData.edges) ? graphData.edges : [];
  const communities =
    graphData && Array.isArray(graphData.communities) ? graphData.communities : [];

  const communityCounts = new Map();
  const typeCounts = new Map();

  for (const node of nodes) {
    if (node.communityId) {
      communityCounts.set(
        node.communityId,
        (communityCounts.get(node.communityId) || 0) + 1,
      );
    }
    if (node.type) {
      typeCounts.set(node.type, (typeCounts.get(node.type) || 0) + 1);
    }
  }

  const topCommunities = communities
    .map((community) => ({
      id: community.id,
      title: community.title || community.id,
      summary: community.summary || "",
      color: community.color || "",
      count: communityCounts.get(community.id) || 0,
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.title.localeCompare(b.title);
    })
    .slice(0, OVERVIEW_COMMUNITY_LIMIT);

  const entityTypes = Array.from(typeCounts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.type.localeCompare(b.type);
    });

  return {
    stats: {
      entities: statsData?.entities ?? nodes.length,
      relations: statsData?.relations ?? edges.length,
      communities: statsData?.communities ?? communities.length,
      commits: statsData?.commits ?? 0,
      lastIndexedAt: statsData?.lastIndexedAt ?? null,
    },
    topCommunities,
    entityTypes,
    truncated: graphData?.truncated ?? null,
  };
}

// Pure: true only when the response body actually carries an entity. A 404
// body (e.g. { error: "not found" }) or an empty object returns false, so the
// caller can render a clean not-found state instead of crashing.
export function hasEntityDetail(detail) {
  return Boolean(detail && detail.entity);
}

export function hasCommunityDetail(detail) {
  return Boolean(detail && typeof detail.id === "string" && detail.id.length > 0);
}

// Pure: the clean "entity not found" sidebar body.
export function notFoundSidebarHtml() {
  return '<p class="inspector-muted">Entity not found.</p>';
}

// ================================================================
// Overview
// ================================================================

export function renderOverviewInspector(graphData = state.graphData, statsData = state.statsData) {
  if (graphData) state.graphData = graphData;
  if (statsData) state.statsData = statsData;

  const model = buildOverviewModel(state.graphData, state.statsData);
  const content = document.getElementById("sidebar-content");
  content.innerHTML = renderOverviewHtml(model);
  setCloseVisible(false);
  openSidebar("overview");
  wireInspectorActions(content);
}

function renderOverviewHtml(model) {
  const stats = model.stats;
  let html = "";
  html += '<div class="inspector-kicker">Repository overview</div>';
  html += '<div class="entity-name">Graph workspace</div>';
  html +=
    '<div class="entity-meta">' +
    formatNumber(stats.entities) +
    " entities | " +
    formatNumber(stats.relations) +
    " relations | " +
    formatNumber(stats.communities) +
    " communities</div>";

  html += '<div class="inspector-metrics">';
  html += metricHtml("Commits", formatNumber(stats.commits));
  html += metricHtml("Last indexed", stats.lastIndexedAt ? formatDate(stats.lastIndexedAt) : "Not indexed");
  if (model.truncated) {
    html += metricHtml(
      "Visible slice",
      formatNumber(model.truncated.shownNodes) +
        " / " +
        formatNumber(model.truncated.totalNodes),
    );
  }
  html += "</div>";

  if (model.topCommunities.length > 0) {
    html += '<div class="section-title">Top communities</div>';
    for (const community of model.topCommunities) {
      html += communityButtonHtml(community);
    }
  }

  if (model.entityTypes.length > 0) {
    html += '<div class="section-title">Entity mix</div>';
    html += '<div class="inspector-type-grid">';
    for (const item of model.entityTypes) {
      html +=
        '<div class="inspector-type-pill">' +
        '<span>' +
        escapeHtml(item.type) +
        "</span>" +
        '<b>' +
        formatNumber(item.count) +
        "</b>" +
        "</div>";
    }
    html += "</div>";
  }

  html +=
    '<div class="inspector-empty-note">Select a node or community to inspect its relationships, evidence, and next actions.</div>';
  return html;
}

function metricHtml(label, value) {
  return (
    '<div class="inspector-metric">' +
    '<span>' +
    escapeHtml(label) +
    "</span>" +
    "<b>" +
    escapeHtml(String(value)) +
    "</b>" +
    "</div>"
  );
}

function communityButtonHtml(community) {
  const color = community.color || state.communityColors[community.id] || getColors().nodeFallback;
  const countLabel =
    typeof community.count === "number" ? formatNumber(community.count) + " entities" : "";
  const summaryLabel = community.summary ? escapeHtml(community.summary.slice(0, 120)) : "";
  const detailsLabel =
    countLabel && summaryLabel ? countLabel + " - " + summaryLabel : countLabel || summaryLabel;
  return (
    '<button type="button" class="community-item inspector-clickable" data-community-id="' +
    escapeAttr(community.id) +
    '">' +
    '<span class="community-dot" style="background:' +
    escapeAttr(color) +
    '"></span>' +
    '<span class="community-info">' +
    '<span class="community-title">' +
    escapeHtml(community.title) +
    "</span>" +
    '<span class="community-summary">' +
    detailsLabel +
    "</span>" +
    "</span>" +
    "</button>"
  );
}

// ================================================================
// Entity selection
// ================================================================

export function selectNode(nodeId) {
  applySelection(nextInspectorSelection(null, { type: "node", id: nodeId }));
  if (state.renderer) state.renderer.refresh();
  scheduleUrlUpdate();
  zoomToNode(nodeId);

  showSidebarMessage('<div class="inspector-loading">Loading entity...</div>', "entity");

  fetch("/api/entity/" + encodeURIComponent(nodeId))
    .then((r) => {
      if (!r.ok) {
        showSidebarMessage(notFoundSidebarHtml(), "entity");
        return null;
      }
      return r.json();
    })
    .then((detail) => {
      if (detail === null) return;
      renderEntityInspector(detail);
    })
    .catch(() => {
      showSidebarMessage(
        '<p class="inspector-error">Failed to load entity details.</p>',
        "entity",
      );
    });
}

function renderEntityInspector(detail) {
  if (!hasEntityDetail(detail)) {
    showSidebarMessage(notFoundSidebarHtml(), "entity");
    return;
  }

  const e = detail.entity;
  let html = "";
  html += '<div class="inspector-kicker">' + escapeHtml(e.type) + "</div>";
  html += '<div class="entity-name">' + escapeHtml(e.name) + "</div>";
  html +=
    '<div class="entity-meta">' +
    escapeHtml(e.id) +
    " | freq " +
    formatNumber(e.frequency) +
    "</div>";
  html +=
    '<div class="entity-description">' +
    escapeHtml(e.description || "No summary available for this entity.") +
    "</div>";
  html +=
    '<div class="inspector-actions">' +
    actionButtonHtml("Zoom", "zoom-node", e.id) +
    actionButtonHtml("Copy ID", "copy", e.id) +
    actionButtonHtml("Copy name", "copy", e.name) +
    "</div>";

  if (detail.communities.length > 0) {
    html += '<div class="section-title">Community</div>';
    for (const c of detail.communities) {
      html += communityButtonHtml({
        id: c.id,
        title: c.title || c.id,
        summary: c.summary || "",
        count: "",
        color: state.communityColors[c.id],
      });
    }
  }

  if (detail.relations.length > 0) {
    html +=
      '<div class="section-title">Strongest direct relationships</div>' +
      '<div class="relation-list">';
    for (const rel of detail.relations.slice(0, ENTITY_RELATION_LIMIT)) {
      html += relationButtonHtml(rel);
    }
    html += "</div>";
  }

  if (detail.recentCommits.length > 0) {
    html += '<div class="section-title">Recent commits</div>';
    for (const c of detail.recentCommits.slice(0, ENTITY_COMMIT_LIMIT)) {
      html +=
        '<div class="commit-item">' +
        '<span class="commit-hash">' +
        escapeHtml(c.hash) +
        "</span>" +
        '<span class="commit-message">' +
        escapeHtml(c.message) +
        "</span>" +
        '<span class="commit-date">' +
        formatDate(c.date) +
        "</span>" +
        "</div>";
    }
  }

  html +=
    '<div class="entity-timestamps">' +
    "<span>First seen: " +
    escapeHtml(e.firstSeen) +
    "</span>" +
    "<span>Last seen: " +
    escapeHtml(e.lastSeen) +
    "</span>" +
    "</div>";

  const content = document.getElementById("sidebar-content");
  content.innerHTML = html;
  setCloseVisible(true);
  openSidebar("entity");
  wireInspectorActions(content);
}

function relationButtonHtml(rel) {
  const arrow = rel.direction === "outgoing" ? "-&gt;" : "&lt;-";
  return (
    '<button type="button" class="relation-item" data-target-id="' +
    escapeAttr(rel.targetId) +
    '">' +
    '<span class="relation-arrow">' +
    arrow +
    "</span>" +
    '<span class="relation-main">' +
    '<span class="relation-name">' +
    escapeHtml(rel.targetName) +
    "</span>" +
    '<span class="relation-description">' +
    escapeHtml(rel.description || rel.targetType) +
    "</span>" +
    "</span>" +
    '<span class="relation-type">' +
    escapeHtml(rel.type) +
    "</span>" +
    '<span class="relation-weight">' +
    formatNumber(rel.weight) +
    "</span>" +
    "</button>"
  );
}

// ================================================================
// Community selection
// ================================================================

export function selectCommunity(communityId) {
  applySelection(nextInspectorSelection(null, { type: "community", id: communityId }));
  if (state.path.active) {
    clearPathStateOnly();
  }
  if (state.renderer) state.renderer.refresh();
  scheduleUrlUpdate();
  zoomToCommunity(communityId);

  showSidebarMessage('<div class="inspector-loading">Loading community...</div>', "community");

  fetch("/api/community/" + encodeURIComponent(communityId))
    .then((res) => {
      if (!res.ok) {
        showSidebarMessage(
          '<p class="inspector-muted">Community not found.</p>',
          "community",
        );
        return null;
      }
      return res.json();
    })
    .then((detail) => {
      if (detail) renderCommunityInspector(detail);
    })
    .catch(() => {
      showSidebarMessage(
        '<p class="inspector-error">Failed to load community details.</p>',
        "community",
      );
    });
}

function clearPathStateOnly() {
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
  const banner = document.getElementById("path-banner");
  if (banner) {
    banner.hidden = true;
    banner.classList.remove("is-error");
  }
}

function renderCommunityInspector(detail) {
  if (!hasCommunityDetail(detail)) {
    showSidebarMessage('<p class="inspector-muted">Community not found.</p>', "community");
    return;
  }

  let html = "";
  html += '<div class="inspector-kicker">Community</div>';
  html += '<div class="entity-name">' + escapeHtml(detail.title || detail.id) + "</div>";
  html += '<div class="entity-meta">' + escapeHtml(detail.id) + "</div>";
  html +=
    '<div class="entity-description">' +
    escapeHtml(
      detail.summary ||
        "No summary available. Re-run hald scan with summarization to generate one.",
    ) +
    "</div>";
  html +=
    '<div class="inspector-actions">' +
    actionButtonHtml("Zoom", "zoom-community", detail.id) +
    actionButtonHtml("Copy ID", "copy", detail.id) +
    "</div>";

  if (detail.topEntities && detail.topEntities.length > 0) {
    html += '<div class="section-title">Top entities</div>';
    for (const entity of detail.topEntities) {
      html += entityButtonHtml(entity);
    }
  }

  if (detail.topRelationTypes && detail.topRelationTypes.length > 0) {
    html += '<div class="section-title">Relationship mix</div>';
    html += '<div class="inspector-type-grid">';
    for (const relType of detail.topRelationTypes) {
      html +=
        '<div class="inspector-type-pill">' +
        '<span>' +
        escapeHtml(relType.type) +
        "</span>" +
        '<b>' +
        formatNumber(relType.count) +
        "</b>" +
        "</div>";
    }
    html += "</div>";
  }

  if (detail.strongestRelations && detail.strongestRelations.length > 0) {
    html += '<div class="section-title">Defining relationships</div>';
    for (const rel of detail.strongestRelations) {
      html += communityRelationHtml(rel);
    }
  }

  const content = document.getElementById("sidebar-content");
  content.innerHTML = html;
  setCloseVisible(true);
  openSidebar("community");
  wireInspectorActions(content);
}

function entityButtonHtml(entity) {
  return (
    '<button type="button" class="cluster-entity" data-entity-id="' +
    escapeAttr(entity.id) +
    '">' +
    '<span class="cluster-entity-type">' +
    escapeHtml(entity.type) +
    "</span>" +
    '<span class="cluster-entity-name">' +
    escapeHtml(entity.name) +
    "</span>" +
    '<span class="cluster-entity-freq">' +
    formatNumber(entity.frequency) +
    "</span>" +
    "</button>"
  );
}

function communityRelationHtml(rel) {
  return (
    '<div class="community-relation">' +
    '<div class="community-relation-main">' +
    '<button type="button" class="community-relation-entity" data-entity-id="' +
    escapeAttr(rel.sourceId) +
    '">' +
    escapeHtml(rel.sourceName) +
    "</button>" +
    '<span class="community-relation-arrow">-&gt;</span>' +
    '<button type="button" class="community-relation-entity" data-entity-id="' +
    escapeAttr(rel.targetId) +
    '">' +
    escapeHtml(rel.targetName) +
    "</button>" +
    "</div>" +
    '<div class="community-relation-meta">' +
    escapeHtml(rel.type) +
    " | weight " +
    formatNumber(rel.weight) +
    "</div>" +
    (rel.description
      ? '<div class="community-relation-description">' +
        escapeHtml(rel.description) +
        "</div>"
      : "") +
    "</div>"
  );
}

// ================================================================
// Shared DOM wiring
// ================================================================

export function closeSidebar() {
  applySelection(nextInspectorSelection(null, { type: "overview" }));
  if (state.renderer) state.renderer.refresh();
  scheduleUrlUpdate();
  renderOverviewInspector();
}

function applySelection(selection) {
  state.selectedNode = selection.selectedNode;
  state.selectedCommunity = selection.selectedCommunity;
}

function showSidebarMessage(html, mode = "overview") {
  document.getElementById("sidebar-content").innerHTML = html;
  setCloseVisible(mode !== "overview");
  openSidebar(mode);
}

function openSidebar(mode) {
  const sidebar = document.getElementById("sidebar");
  sidebar.classList.add("open");
  sidebar.dataset.mode = mode;
}

function setCloseVisible(visible) {
  const button = document.getElementById("sidebar-close");
  if (!button) return;
  button.hidden = !visible;
}

function wireInspectorActions(content) {
  content.querySelectorAll("[data-target-id]").forEach((item) => {
    item.addEventListener("click", () => {
      const targetId = item.getAttribute("data-target-id");
      if (targetId && state.graph.hasNode(targetId)) {
        selectNode(targetId);
      }
    });
  });

  content.querySelectorAll("[data-entity-id]").forEach((item) => {
    item.addEventListener("click", () => {
      const entityId = item.getAttribute("data-entity-id");
      if (entityId && state.graph.hasNode(entityId)) {
        selectNode(entityId);
      }
    });
  });

  content.querySelectorAll("[data-community-id]").forEach((item) => {
    item.addEventListener("click", () => {
      const communityId = item.getAttribute("data-community-id");
      if (communityId) selectCommunity(communityId);
    });
  });

  content.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.getAttribute("data-action");
      const value = button.getAttribute("data-value") || "";
      if (action === "copy") copyText(value, button);
      if (action === "zoom-node") zoomToNode(value);
      if (action === "zoom-community") zoomToCommunity(value);
    });
  });
}

function actionButtonHtml(label, action, value) {
  return (
    '<button type="button" class="inspector-action" data-action="' +
    escapeAttr(action) +
    '" data-value="' +
    escapeAttr(value) +
    '">' +
    escapeHtml(label) +
    "</button>"
  );
}

function copyText(value, button) {
  if (!value || !navigator.clipboard) {
    flashButtonLabel(button, "Unavailable");
    return;
  }
  navigator.clipboard
    .writeText(value)
    .then(() => flashButtonLabel(button, "Copied"))
    .catch(() => flashButtonLabel(button, "Failed"));
}

function flashButtonLabel(button, label) {
  const original = button.textContent;
  button.textContent = label;
  setTimeout(() => {
    button.textContent = original;
  }, 1400);
}

function zoomToNode(nodeId) {
  if (!state.renderer || !nodeId) return;
  const nodePos = state.renderer.getNodeDisplayData(nodeId);
  if (!nodePos) return;
  state.renderer.getCamera().animate(
    { x: nodePos.x, y: nodePos.y, ratio: 0.35 },
    { duration: prefersReducedMotion() ? 0 : 400 },
  );
}

function zoomToCommunity(communityId) {
  if (!state.renderer || !state.graph || !communityId) return;

  let count = 0;
  let x = 0;
  let y = 0;
  state.graph.forEachNode((node, attrs) => {
    if (attrs._halo || attrs.communityId !== communityId) return;
    x += attrs.x;
    y += attrs.y;
    count += 1;
  });

  if (count === 0) return;

  state.renderer.getCamera().animate(
    { x: x / count, y: y / count, ratio: count > 8 ? 0.85 : 0.55 },
    { duration: prefersReducedMotion() ? 0 : 420 },
  );
}

function formatNumber(value) {
  if (typeof value !== "number") return String(value || 0);
  return value.toLocaleString();
}
