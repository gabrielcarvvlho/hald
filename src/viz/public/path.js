// ================================================================
// Path finding — client-side BFS over the in-memory graph
// ================================================================
//
// Why client-side BFS: graphology's UMD doesn't bundle shortest-path
// helpers. The graph is in memory anyway, so a 20-line BFS is simpler
// than wiring an /api/path endpoint and avoids a round trip. O(V+E)
// is fine well past the practical viz size ceiling.
//
// Pure module: takes a graphology graph as an argument and never
// touches the DOM/window/Sigma, so it imports cleanly into vitest.

import { isHalo } from "./halo.js";

export function findShortestPath(graph, src, tgt) {
  if (!graph || !graph.hasNode(src) || !graph.hasNode(tgt)) return null;
  if (src === tgt) return [src];
  const visited = new Set([src]);
  const parent = new Map();
  const queue = [src];
  while (queue.length) {
    const node = queue.shift();
    const neighbors = graph.neighbors(node);
    for (const n of neighbors) {
      if (visited.has(n)) continue;
      // Halos have no edges, but defend in case future code adds them.
      if (isHalo(n)) continue;
      visited.add(n);
      parent.set(n, node);
      if (n === tgt) {
        // Reconstruct path back to src.
        const path = [tgt];
        let cur = tgt;
        while (parent.has(cur)) {
          cur = parent.get(cur);
          path.unshift(cur);
        }
        return path;
      }
      queue.push(n);
    }
  }
  return null;
}

export function buildPathEdgeSet(graph, pathNodes) {
  const set = new Set();
  for (let i = 0; i < pathNodes.length - 1; i++) {
    const e = graph.edge(pathNodes[i], pathNodes[i + 1]);
    if (e) set.add(e);
  }
  return set;
}

// Walk the path and grab the edgeType of the connecting edge for each
// pair. Length always === pathNodes.length - 1. Null entries mean the
// edge wasn't found in the graph (defensive — shouldn't happen for a
// path produced by BFS, but guards against drift).
export function buildPathEdgeTypes(graph, pathNodes) {
  const out = [];
  for (let i = 0; i < pathNodes.length - 1; i++) {
    const e = graph.edge(pathNodes[i], pathNodes[i + 1]);
    if (!e) {
      out.push(null);
      continue;
    }
    const t = graph.getEdgeAttribute(e, "edgeType");
    out.push(typeof t === "string" ? t : null);
  }
  return out;
}
