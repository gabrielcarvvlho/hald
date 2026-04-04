/* global graphology, Sigma */

// ================================================================
// State
// ================================================================

const state = {
  renderer: null,
  graph: null,
  hoveredNode: null,
  selectedNode: null,
  searchQuery: "",
  hiddenTypes: new Set(),
  communityColors: {},
  neighbors: new Map(), // nodeId → Set<nodeId>
};

// ================================================================
// Init
// ================================================================

async function init() {
  const loadingEl = document.getElementById("loading");

  if (typeof graphology === "undefined" || typeof Sigma === "undefined") {
    loadingEl.textContent = "Failed to load dependencies. Check your internet connection.";
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
        '<div class="empty-state-text">Try indexing more commits with <code>git-oracle index</code></div></div>';
      return;
    }

    // Remove loading
    loadingEl.remove();

    // Build graph + render
    buildGraph(graphData);
    createRenderer();
    setupEvents();
    setupSearch();
    setupFilters();
  } catch (err) {
    loadingEl.textContent = "Failed to load graph data: " + err.message;
    loadingEl.classList.add("error");
  }
}

// ================================================================
// Stats
// ================================================================

function renderStats(stats) {
  const el = document.getElementById("stats-text");
  const parts = [];
  if (stats.entities) parts.push(stats.entities + " entities");
  if (stats.relations) parts.push(stats.relations + " relations");
  if (stats.communities) parts.push(stats.communities + " communities");
  el.textContent = parts.join(" \u00b7 ");
}

// ================================================================
// Build Graph
// ================================================================

function buildGraph(data) {
  const Graph = graphology.Graph;
  const graph = new Graph();

  // Store community colors
  for (const c of data.communities) {
    state.communityColors[c.id] = c.color;
  }

  // Add nodes
  for (const node of data.nodes) {
    const color = node.communityId ? (state.communityColors[node.communityId] || "#94a3b8") : "#94a3b8";
    const size = 4 + Math.min(16, Math.log(node.frequency + 1) * 4);

    graph.addNode(node.id, {
      x: node.x,
      y: node.y,
      size: size,
      color: color,
      label: node.name,
      // Custom data for filtering/display
      nodeType: node.type,
      communityId: node.communityId,
      borderColor: "#ffffff",
    });
  }

  // Add edges
  for (const edge of data.edges) {
    let sourceCommunity = null;
    let targetCommunity = null;
    try {
      sourceCommunity = graph.getNodeAttribute(edge.source, "communityId");
      targetCommunity = graph.getNodeAttribute(edge.target, "communityId");
    } catch (e) {
      // Node may not exist
    }
    const isCross = sourceCommunity !== targetCommunity;

    try {
      graph.addEdge(edge.source, edge.target, {
        size: 0.5 + Math.min(3, Math.log(edge.weight + 1)),
        color: isCross ? "rgba(148,163,184,0.45)" : "rgba(100,116,139,0.55)",
        edgeType: edge.type,
      });
    } catch (e) {
      // Skip duplicate edges
    }
  }

  // Pre-compute neighbor sets for hover effects
  graph.forEachNode((node) => {
    state.neighbors.set(node, new Set(graph.neighbors(node)));
  });

  state.graph = graph;
}

// ================================================================
// Create Renderer
// ================================================================

function createRenderer() {
  const container = document.getElementById("graph-container");
  const renderer = new Sigma(state.graph, container, {
    defaultNodeColor: "#94a3b8",
    defaultEdgeColor: "rgba(100,116,139,0.5)",
    labelFont: "system-ui, sans-serif",
    labelColor: { color: "#1e293b" },
    labelSize: 12,
    labelRenderedSizeThreshold: 8,
    nodeProgramClasses: {},
    nodeReducer: nodeReducer,
    edgeReducer: edgeReducer,
    zIndex: true,
    minCameraRatio: 0.02,
    maxCameraRatio: 10,
  });

  state.renderer = renderer;
}

// ================================================================
// Reducers
// ================================================================

function nodeReducer(node, data) {
  const res = { ...data };

  // Type filtering
  if (state.hiddenTypes.has(data.nodeType)) {
    res.hidden = true;
    return res;
  }

  // Search dimming
  if (state.searchQuery) {
    const matches = data.label.toLowerCase().includes(state.searchQuery);
    if (!matches) {
      res.color = "#e2e8f0";
      res.label = "";
      res.zIndex = 0;
    } else {
      res.highlighted = true;
      res.zIndex = 2;
    }
  }

  // Hover / selection highlight
  const activeNode = state.hoveredNode || state.selectedNode;
  if (activeNode) {
    if (node === activeNode) {
      res.highlighted = true;
      res.size = data.size * 1.4;
      res.zIndex = 2;
    } else {
      const neighbors = state.neighbors.get(activeNode);
      if (neighbors && neighbors.has(node)) {
        res.zIndex = 1;
      } else {
        res.color = "#e2e8f0";
        res.label = "";
        res.zIndex = 0;
      }
    }
  }

  return res;
}

function edgeReducer(edge, data) {
  const res = { ...data };
  const activeNode = state.hoveredNode || state.selectedNode;

  if (activeNode) {
    const graph = state.graph;
    const source = graph.source(edge);
    const target = graph.target(edge);

    if (source === activeNode || target === activeNode) {
      res.color = "#94a3b8";
      res.size = Math.max(data.size, 1.5);
      res.zIndex = 1;
    } else {
      res.color = "rgba(226,232,240,0.2)";
      res.zIndex = 0;
    }
  }

  // Hide edges connected to hidden nodes
  const graph = state.graph;
  const sourceType = graph.getNodeAttribute(graph.source(edge), "nodeType");
  const targetType = graph.getNodeAttribute(graph.target(edge), "nodeType");
  if (state.hiddenTypes.has(sourceType) || state.hiddenTypes.has(targetType)) {
    res.hidden = true;
  }

  return res;
}

// ================================================================
// Events
// ================================================================

function setupEvents() {
  const renderer = state.renderer;

  // Hover
  renderer.on("enterNode", ({ node }) => {
    state.hoveredNode = node;
    document.body.style.cursor = "pointer";
    renderer.refresh();
  });

  renderer.on("leaveNode", () => {
    state.hoveredNode = null;
    document.body.style.cursor = "default";
    renderer.refresh();
  });

  // Click node → open sidebar
  renderer.on("clickNode", ({ node }) => {
    selectNode(node);
  });

  // Click empty space → close sidebar
  renderer.on("clickStage", () => {
    closeSidebar();
  });

  // Sidebar close button
  document.getElementById("sidebar-close").addEventListener("click", closeSidebar);
}

// ================================================================
// Sidebar
// ================================================================

function selectNode(nodeId) {
  state.selectedNode = nodeId;
  state.renderer.refresh();

  // Fly-to node
  const nodePos = state.renderer.getNodeDisplayData(nodeId);
  if (nodePos) {
    state.renderer.getCamera().animate(
      { x: nodePos.x, y: nodePos.y, ratio: 0.35 },
      { duration: 400 },
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

function closeSidebar() {
  state.selectedNode = null;
  document.getElementById("sidebar").classList.remove("open");
  state.renderer.refresh();
}

function renderSidebar(detail) {
  const e = detail.entity;
  let html = "";

  // Entity header
  html += '<div class="entity-name">' + escapeHtml(e.name) + "</div>";
  html += '<div class="entity-meta">' + e.type + " \u00b7 freq " + e.frequency + "</div>";
  html += '<div class="entity-description">' + escapeHtml(e.description) + "</div>";

  // Relations
  if (detail.relations.length > 0) {
    html += '<div class="section-title">Relations (' + detail.relations.length + ")</div>";
    for (const rel of detail.relations) {
      const arrow = rel.direction === "outgoing" ? "\u2192" : "\u2190";
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
      const color = state.communityColors[c.id] || "#94a3b8";
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

// ================================================================
// Search
// ================================================================

function setupSearch() {
  const input = document.getElementById("search-input");
  let debounceTimer = null;

  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      state.searchQuery = input.value.trim().toLowerCase();
      state.renderer.refresh();

      // Fly to first match
      if (state.searchQuery) {
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
          const pos = state.renderer.getNodeDisplayData(bestNode);
          if (pos) {
            state.renderer.getCamera().animate(
              { x: pos.x, y: pos.y, ratio: 0.5 },
              { duration: 300 },
            );
          }
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
// Filters
// ================================================================

function setupFilters() {
  document.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const type = chip.getAttribute("data-type");
      if (state.hiddenTypes.has(type)) {
        state.hiddenTypes.delete(type);
        chip.classList.add("active");
      } else {
        state.hiddenTypes.add(type);
        chip.classList.remove("active");
      }
      state.renderer.refresh();
    });
  });
}

// ================================================================
// Helpers
// ================================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;");
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) return "today";
    if (diffDays === 1) return "yesterday";
    if (diffDays < 30) return diffDays + "d ago";
    if (diffDays < 365) return Math.floor(diffDays / 30) + "mo ago";
    return Math.floor(diffDays / 365) + "y ago";
  } catch {
    return iso;
  }
}

// ================================================================
// Start
// ================================================================

init();
