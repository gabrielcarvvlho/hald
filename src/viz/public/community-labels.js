// ================================================================
// Community labels — floating divs at cluster centroids.
// Each label shows the LLM-generated title + summary on hover.
// Position is recomputed on every render via afterRender, batched in
// requestAnimationFrame for GPU-friendly transform updates (per P3).
// ================================================================

import { state } from "./state.js";

export function setupCommunityLabels(graphData) {
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
    // Skip singletons and pairs — too small to deserve a floating label
    // and they just add visual clutter on dense graphs.
    if (members.length < 3) continue;

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
    // Store member IDs so the per-render positioner can project LIVE
    // sigma graph coords (not the stale API snapshot), making labels
    // follow the cluster as it breathes/drifts under motion. Falling
    // back to the API x/y if a node ever disappears keeps positions
    // sane during transitions.
    state.communityLabels.push({
      el: label,
      memberIds: members.map((n) => n.id),
      memberFallback: members.map((n) => ({ x: n.x, y: n.y })),
      title: community.title,
      color: community.color,
    });
  }

  // Reposition on every render. RAF-batched to coalesce zoom/pan bursts.
  // Strategy: project every cluster member to screen, anchor the label
  // at the TOPMOST projected member with a small upward offset so the
  // text never sits on top of a node. The previous version anchored at
  // the centroid which guaranteed overlap with whichever node was
  // closest to the cluster's geometric center.
  const LABEL_OFFSET_PX = 18;
  let raf = null;
  function update() {
    raf = null;
    const ratio = state.renderer.getCamera().getState().ratio;
    // Smooth fade as we zoom in. node labels take over below ratio 0.5.
    // 0.4 → 0% opacity, 0.7 → 100% opacity, linear ramp between.
    const fadeOpacity = Math.max(0, Math.min(1, (ratio - 0.4) / 0.3));
    for (const l of state.communityLabels) {
      let topX = 0;
      let topY = Infinity;
      let anyVisible = false;
      for (let i = 0; i < l.memberIds.length; i++) {
        const id = l.memberIds[i];
        let gx;
        let gy;
        if (state.graph && state.graph.hasNode(id)) {
          // Skip members hidden by type filters — labels should anchor
          // only to currently-visible nodes.
          const nodeType = state.graph.getNodeAttribute(id, "nodeType");
          if (state.hiddenTypes.has(nodeType)) continue;
          gx = state.graph.getNodeAttribute(id, "x");
          gy = state.graph.getNodeAttribute(id, "y");
        } else {
          gx = l.memberFallback[i].x;
          gy = l.memberFallback[i].y;
        }
        const pt = state.renderer.graphToViewport({ x: gx, y: gy });
        if (pt.y < topY) {
          topY = pt.y;
          topX = pt.x;
          anyVisible = true;
        }
      }
      if (!anyVisible) {
        l.el.style.display = "none";
        continue;
      }
      l.el.style.display = "";
      // Anchor the bottom-center of the label LABEL_OFFSET_PX above
      // the topmost cluster node. translate(-50%, -100%) shifts the
      // label so its baseline sits at the offset point.
      l.el.style.transform =
        "translate(" +
        Math.round(topX) +
        "px, " +
        Math.round(topY - LABEL_OFFSET_PX) +
        "px) translate(-50%, -100%)";
      // Smooth opacity per zoom — overrides the binary data-faded
      // attribute so we get a gentle ramp instead of a snap.
      l.el.style.opacity = String(fadeOpacity);
      if (fadeOpacity < 0.5) {
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
