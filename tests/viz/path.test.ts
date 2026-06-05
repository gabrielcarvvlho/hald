import { describe, it, expect } from "vitest";
import Graph from "graphology";
// @ts-expect-error — browser ESM module, no .d.ts; runtime-importable in Node.
import {
  findShortestPath,
  buildPathEdgeSet,
  buildPathEdgeTypes,
} from "../../src/viz/public/path.js";

// Build a tiny labeled graph:
//   a ─AUTHORED→ b ─USES→ c
//   a ─────────────────── d (disconnected from c except via b? no — d is a leaf off a)
//   isolated: e
function makeGraph(): Graph {
  const g = new Graph();
  for (const id of ["a", "b", "c", "d", "e"]) g.addNode(id, { label: id.toUpperCase() });
  g.addEdge("a", "b", { edgeType: "AUTHORED" });
  g.addEdge("b", "c", { edgeType: "USES" });
  g.addEdge("a", "d", { edgeType: "CO_CHANGED" });
  // "e" is isolated.
  return g;
}

describe("findShortestPath", () => {
  it("finds a multi-hop path", () => {
    const g = makeGraph();
    expect(findShortestPath(g, "a", "c")).toEqual(["a", "b", "c"]);
  });

  it("returns a single-node path when src === tgt", () => {
    const g = makeGraph();
    expect(findShortestPath(g, "a", "a")).toEqual(["a"]);
  });

  it("finds a direct one-hop path", () => {
    const g = makeGraph();
    expect(findShortestPath(g, "a", "b")).toEqual(["a", "b"]);
  });

  it("returns null when no path exists (isolated node)", () => {
    const g = makeGraph();
    expect(findShortestPath(g, "a", "e")).toBeNull();
  });

  it("returns null when an endpoint is missing", () => {
    const g = makeGraph();
    expect(findShortestPath(g, "a", "zzz")).toBeNull();
    expect(findShortestPath(g, "zzz", "a")).toBeNull();
  });

  it("returns null for a nullish graph", () => {
    expect(findShortestPath(null, "a", "b")).toBeNull();
  });

  it("picks the shorter of two routes", () => {
    const g = new Graph();
    for (const id of ["x", "y", "z", "w"]) g.addNode(id);
    // x→y→z (2 hops) vs x→w→...: make a shortcut x→z directly absent,
    // but x→w and w→z exists; both are 2 hops, BFS finds first discovered.
    g.addEdge("x", "y");
    g.addEdge("y", "z");
    g.addEdge("x", "z"); // direct 1-hop shortcut
    const path = findShortestPath(g, "x", "z");
    expect(path).toEqual(["x", "z"]);
  });
});

describe("buildPathEdgeSet", () => {
  it("collects edge keys along the path", () => {
    const g = makeGraph();
    const nodes = ["a", "b", "c"];
    const set = buildPathEdgeSet(g, nodes);
    expect(set.size).toBe(2);
    expect(set.has(g.edge("a", "b"))).toBe(true);
    expect(set.has(g.edge("b", "c"))).toBe(true);
  });

  it("is empty for a single-node path", () => {
    const g = makeGraph();
    expect(buildPathEdgeSet(g, ["a"]).size).toBe(0);
  });
});

describe("buildPathEdgeTypes", () => {
  it("returns the edgeType per gap, length === nodes.length - 1", () => {
    const g = makeGraph();
    const types = buildPathEdgeTypes(g, ["a", "b", "c"]);
    expect(types).toEqual(["AUTHORED", "USES"]);
    expect(types.length).toBe(2);
  });

  it("emits null when an edge is missing between two nodes", () => {
    const g = makeGraph();
    // a and c are not directly connected.
    const types = buildPathEdgeTypes(g, ["a", "c"]);
    expect(types).toEqual([null]);
  });

  it("emits null when the edge lacks an edgeType attribute", () => {
    const g = new Graph();
    g.addNode("p");
    g.addNode("q");
    g.addEdge("p", "q"); // no edgeType attribute
    expect(buildPathEdgeTypes(g, ["p", "q"])).toEqual([null]);
  });
});
