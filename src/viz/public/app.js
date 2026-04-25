/* global graphology, Sigma */

// ================================================================
// Colors — centralized so dark mode (item #7) is a swap, not a hunt.
// All sigma renderer + reducer colors must read from here.
// ================================================================

const COLORS = {
  nodeFallback: "#94a3b8",                    // node with no community
  nodeBorder: "#ffffff",
  edgeIntra: "rgba(100,116,139,0.55)",        // within community
  edgeCross: "rgba(148,163,184,0.45)",        // crossing communities
  edgeDefault: "rgba(100,116,139,0.5)",       // sigma defaultEdgeColor
  labelText: "#1e293b",
  dimNode: "#e2e8f0",                         // dimmed during search/hover
  dimEdge: "rgba(226,232,240,0.2)",
  hoverEdge: "#94a3b8",
  // Type chip colors. Unknown types fall back to nodeFallback.
  typeColors: {
    PERSON: "#3b82f6",
    MODULE: "#10b981",
    TECHNOLOGY: "#f59e0b",
    DECISION: "#8b5cf6",
    PATTERN: "#ec4899",
    CONCEPT: "#14b8a6",
    RISK: "#ef4444",
    PROCESS: "#f97316",
  },
};

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
    loadingEl.textContent = "Failed to load graph engine. Try rebuilding with `npm run build`.";
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

    // Build graph + render
    buildGraph(graphData);
    createRenderer();
    setupTypeChips(graphData);
    setupEvents();
    setupSearch();
    setupFilters();
    setupCommunityLabels(graphData);
    setupScreenshot();
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
    const color = node.communityId
      ? (state.communityColors[node.communityId] || COLORS.nodeFallback)
      : COLORS.nodeFallback;
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
      borderColor: COLORS.nodeBorder,
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
        color: isCross ? COLORS.edgeCross : COLORS.edgeIntra,
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

  // Force-label the top 5 most-connected nodes so they're always visible —
  // gives newcomers an anchor instead of a wall of unlabeled dots.
  const ranked = [];
  graph.forEachNode((node) => {
    ranked.push({ node, degree: graph.degree(node) });
  });
  ranked.sort((a, b) => b.degree - a.degree);
  for (const { node } of ranked.slice(0, 5)) {
    graph.setNodeAttribute(node, "forceLabel", true);
  }

  state.graph = graph;
}

// ================================================================
// Create Renderer
// ================================================================

function createRenderer() {
  const container = document.getElementById("graph-container");
  const renderer = new Sigma(state.graph, container, {
    defaultNodeColor: COLORS.nodeFallback,
    defaultEdgeColor: COLORS.edgeDefault,
    labelFont: "system-ui, sans-serif",
    labelColor: { color: COLORS.labelText },
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

  // Brief settle animation on first paint — gives the user a sense of motion
  // and confirms "the graph is loading" rather than a static dump.
  const camera = renderer.getCamera();
  camera.setState({ x: 0.5, y: 0.5, ratio: 1.6, angle: 0 });
  requestAnimationFrame(() => {
    camera.animate({ x: 0.5, y: 0.5, ratio: 1.05, angle: 0 }, { duration: 600 });
  });
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
      res.color = COLORS.dimNode;
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
        res.color = COLORS.dimNode;
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
      res.color = COLORS.hoverEdge;
      res.size = Math.max(data.size, 1.5);
      res.zIndex = 1;
    } else {
      res.color = COLORS.dimEdge;
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
// Type chips — schema-driven from actual entity types in the graph.
// Avoids the bug where index.html lists 5 hardcoded types but the
// extractor schema can grow (CONCEPT, RISK, PROCESS, ...).
// Per /plan-eng-review A3 (compute client-side, zero API change).
// ================================================================

function setupTypeChips(graphData) {
  const container = document.getElementById("filter-chips");
  if (!container) return;
  container.innerHTML = "";

  const types = Array.from(new Set(graphData.nodes.map((n) => n.type))).sort();
  for (const type of types) {
    const chip = document.createElement("button");
    chip.className = "filter-chip active";
    chip.dataset.type = type;
    const color = COLORS.typeColors[type] || COLORS.nodeFallback;
    chip.style.setProperty("--chip-color", color);
    // PERSON → Person, TECHNOLOGY → Technology
    chip.textContent = type.charAt(0) + type.slice(1).toLowerCase();
    container.appendChild(chip);
  }
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
// Community labels — floating divs at cluster centroids.
// Each label shows the LLM-generated title + summary on hover.
// Position is recomputed on every render via afterRender, batched in
// requestAnimationFrame for GPU-friendly transform updates (per P3).
// ================================================================

function setupCommunityLabels(graphData) {
  const container = document.getElementById("graph-container");
  let layer = document.getElementById("community-labels");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "community-labels";
    container.appendChild(layer);
  } else {
    layer.innerHTML = "";
  }

  state.communityLabels = [];
  for (const community of graphData.communities) {
    const members = graphData.nodes.filter((n) => n.communityId === community.id);
    if (members.length === 0) continue;

    let sumX = 0;
    let sumY = 0;
    for (const n of members) {
      sumX += n.x;
      sumY += n.y;
    }
    const cx = sumX / members.length;
    const cy = sumY / members.length;

    const label = document.createElement("div");
    label.className = "community-label";
    label.style.color = community.color;
    label.dataset.communityId = community.id;
    label.textContent = community.title;

    const tip = document.createElement("div");
    tip.className = "community-tooltip";
    tip.textContent =
      community.summary ||
      "No summary available — re-run hald scan with summarization.";
    label.appendChild(tip);

    layer.appendChild(label);
    state.communityLabels.push({
      el: label,
      gx: cx,
      gy: cy,
      title: community.title,
      color: community.color,
    });
  }

  // Reposition on every render. RAF-batched to coalesce zoom/pan bursts.
  let raf = null;
  function update() {
    raf = null;
    const ratio = state.renderer.getCamera().getState().ratio;
    // Fade community labels at high zoom — node labels take over.
    const faded = ratio < 0.5;
    for (const l of state.communityLabels) {
      const pt = state.renderer.graphToViewport({ x: l.gx, y: l.gy });
      l.el.style.transform =
        "translate(" + pt.x + "px, " + pt.y + "px) translate(-50%, -50%)";
      if (faded) {
        l.el.setAttribute("data-faded", "true");
      } else {
        l.el.removeAttribute("data-faded");
      }
    }
  }
  function schedule() {
    if (!raf) raf = requestAnimationFrame(update);
  }
  state.renderer.on("afterRender", schedule);
  update();
}

// ================================================================
// Screenshot — composite sigma's canvas layers into a single PNG
// and download. Includes community labels rendered onto the canvas
// (they live as DOM divs in the live UI but need to be baked into
// the image for share-ability).
//
// Disabled when graph is empty (per /plan-eng-review C7).
// ================================================================

function captureScreenshotCanvas() {
  const canvases = state.renderer.getCanvases();
  // Sigma 3 layer names — composite in z-order.
  const layerOrder = ["edges", "nodes", "labels", "hovers", "edgeLabels"];
  const sample = canvases[layerOrder[0]] || Object.values(canvases)[0];
  if (!sample) return null;

  const out = document.createElement("canvas");
  out.width = sample.width;
  out.height = sample.height;
  const ctx = out.getContext("2d");
  if (!ctx) return null;

  // Background — match the body bg so transparency doesn't surprise viewers.
  const bg = getComputedStyle(document.body).backgroundColor || "#f8fafc";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, out.width, out.height);

  // Composite sigma layers
  for (const layer of layerOrder) {
    const c = canvases[layer];
    if (c) ctx.drawImage(c, 0, 0);
  }

  // Render community labels onto the canvas (DPR-aware)
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.font =
    'bold 13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const l of state.communityLabels || []) {
    const pt = state.renderer.graphToViewport({ x: l.gx, y: l.gy });
    // White halo (3 strokes for solid look)
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#ffffff";
    ctx.strokeText(l.title, pt.x, pt.y);
    // Title in the community's color
    ctx.fillStyle = l.color || COLORS.labelText;
    ctx.fillText(l.title, pt.x, pt.y);
  }
  ctx.restore();

  return out;
}

function setupScreenshot() {
  const btn = document.getElementById("btn-screenshot");
  if (!btn) return;

  // Empty graph → button stays disabled (HTML default already has it).
  if (!state.graph || state.graph.order === 0) {
    btn.disabled = true;
    return;
  }
  btn.disabled = false;

  btn.addEventListener("click", () => {
    const canvas = captureScreenshotCanvas();
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const date = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "hald-graph-" + date + ".png";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Defer revoke until next tick so the browser commits the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
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
