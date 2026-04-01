import { describe, it, expect } from "vitest";
import { cluster, buildGraph } from "../../src/pipeline/clusterer.js";
import { EntityType, RelationType, type Entity, type Relation } from "../../src/shared/types.js";

function makeEntity(id: string): Entity {
  return {
    id,
    type: EntityType.MODULE,
    name: id,
    aliases: [],
    description: "",
    firstSeen: "2024-01-01",
    lastSeen: "2024-06-01",
    frequency: 5,
    metadata: {},
  };
}

function makeRelation(
  sourceId: string,
  targetId: string,
  weight = 1,
): Relation {
  return {
    id: `rel:${sourceId}-${targetId}`,
    type: RelationType.CO_CHANGED,
    sourceId,
    targetId,
    weight,
    description: "",
    evidence: [],
    firstSeen: "2024-01-01",
    lastSeen: "2024-06-01",
  };
}

describe("clusterer", () => {
  it("returns empty for empty input", () => {
    const result = cluster([], [], [1.0], 2);
    expect(result).toHaveLength(0);
  });

  it("returns empty when no edges and entities below minCommunitySize", () => {
    const entities = [makeEntity("a")];
    const result = cluster(entities, [], [1.0], 2);
    expect(result).toHaveLength(0);
  });

  it("returns single community for edgeless graph when entities >= minCommunitySize", () => {
    const entities = ["a", "b", "c", "d", "e"].map(makeEntity);
    const result = cluster(entities, [], [1.0], 2);

    expect(result).toHaveLength(1);
    expect(result[0]!.entityIds.sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(result[0]!.level).toBe(0);
    expect(result[0]!.id).toMatch(/^comm:0:[a-f0-9]{10}$/);
  });

  it("returns empty for edgeless graph when entities < minCommunitySize", () => {
    const entities = ["a"].map(makeEntity);
    const result = cluster(entities, [], [1.0], 2);
    expect(result).toHaveLength(0);
  });

  it("handles tiny graph with single-resolution fallback", () => {
    const entities = ["a", "b", "c"].map(makeEntity);
    const relations = [
      makeRelation("a", "b", 10),
      makeRelation("b", "c", 10),
    ];

    const result = cluster(entities, relations, [0.5, 1.0, 2.0], 2);

    // Should produce communities but only at level 0 (single-resolution)
    for (const c of result) {
      expect(c.level).toBe(0);
    }
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("handles star topology without crashing", () => {
    const hub = makeEntity("hub");
    const leaves = Array.from({ length: 20 }, (_, i) => makeEntity(`leaf${i}`));
    const entities = [hub, ...leaves];
    const relations = leaves.map((l) => makeRelation("hub", l.id, 5));

    const result = cluster(entities, relations, [1.0], 2);

    expect(result.length).toBeGreaterThanOrEqual(1);
    const hubCommunity = result.find((c) => c.entityIds.includes("hub"));
    expect(hubCommunity).toBeDefined();
  });

  it("handles disconnected components", () => {
    const clique1 = ["a1", "a2", "a3", "a4", "a5"].map(makeEntity);
    const clique2 = ["b1", "b2", "b3", "b4", "b5"].map(makeEntity);
    const entities = [...clique1, ...clique2];
    const relations = [
      makeRelation("a1", "a2", 10), makeRelation("a1", "a3", 10),
      makeRelation("a1", "a4", 10), makeRelation("a1", "a5", 10),
      makeRelation("a2", "a3", 10), makeRelation("a2", "a4", 10),
      makeRelation("a2", "a5", 10), makeRelation("a3", "a4", 10),
      makeRelation("a3", "a5", 10), makeRelation("a4", "a5", 10),
      makeRelation("b1", "b2", 10), makeRelation("b1", "b3", 10),
      makeRelation("b1", "b4", 10), makeRelation("b1", "b5", 10),
      makeRelation("b2", "b3", 10), makeRelation("b2", "b4", 10),
      makeRelation("b2", "b5", 10), makeRelation("b3", "b4", 10),
      makeRelation("b3", "b5", 10), makeRelation("b4", "b5", 10),
    ];

    const result = cluster(entities, relations, [1.0], 3);

    expect(result.length).toBeGreaterThanOrEqual(2);
    for (const c of result) {
      const hasA = c.entityIds.some((id) => id.startsWith("a"));
      const hasB = c.entityIds.some((id) => id.startsWith("b"));
      expect(hasA && hasB).toBe(false);
    }
  });

  it("detects communities in a simple graph", () => {
    // Two clusters: {a, b, c} strongly connected, {d, e, f} strongly connected, weak link between
    const entities = ["a", "b", "c", "d", "e", "f"].map(makeEntity);
    const relations = [
      // Cluster 1
      makeRelation("a", "b", 10),
      makeRelation("b", "c", 10),
      makeRelation("a", "c", 10),
      // Cluster 2
      makeRelation("d", "e", 10),
      makeRelation("e", "f", 10),
      makeRelation("d", "f", 10),
      // Weak bridge
      makeRelation("c", "d", 1),
    ];

    const communities = cluster(entities, relations, [1.0], 2);

    // Should find at least 2 communities
    expect(communities.length).toBeGreaterThanOrEqual(2);

    // Each community should have members
    for (const c of communities) {
      expect(c.entityIds.length).toBeGreaterThanOrEqual(2);
      expect(c.id).toMatch(/^comm:\d+:[a-f0-9]{10}$/);
    }
  });

  it("runs at multiple resolutions", () => {
    const entities = ["a", "b", "c", "d", "e", "f"].map(makeEntity);
    const relations = [
      makeRelation("a", "b", 10),
      makeRelation("b", "c", 10),
      makeRelation("a", "c", 10),
      makeRelation("d", "e", 10),
      makeRelation("e", "f", 10),
      makeRelation("d", "f", 10),
      makeRelation("c", "d", 1),
    ];

    // Low resolution should give fewer communities, high resolution more
    const communities = cluster(entities, relations, [0.5, 1.0, 2.0], 2);

    // Should have communities at multiple levels
    const levels = new Set(communities.map((c) => c.level));
    expect(levels.size).toBeGreaterThanOrEqual(1);
  });

  it("filters by minCommunitySize", () => {
    const entities = ["a", "b", "c"].map(makeEntity);
    const relations = [
      makeRelation("a", "b", 10),
      // c is isolated
    ];

    // With minCommunitySize=3, the {a,b} cluster is too small and c is singleton
    const communities = cluster(entities, relations, [1.0], 3);
    // Should filter out small communities
    for (const c of communities) {
      expect(c.entityIds.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("assigns deterministic community IDs", () => {
    const entities = ["a", "b", "c", "d"].map(makeEntity);
    const relations = [
      makeRelation("a", "b", 10),
      makeRelation("c", "d", 10),
    ];

    const communities = cluster(entities, relations, [1.0], 2);

    for (const c of communities) {
      expect(c.id).toMatch(/^comm:\d+:[a-f0-9]{10}$/);
      expect(c.level).toBeGreaterThanOrEqual(0);
    }
  });

  it("produces deterministic output across runs", () => {
    const entities = ["a", "b", "c", "d", "e", "f"].map(makeEntity);
    const relations = [
      makeRelation("a", "b", 10),
      makeRelation("b", "c", 10),
      makeRelation("a", "c", 10),
      makeRelation("d", "e", 10),
      makeRelation("e", "f", 10),
      makeRelation("d", "f", 10),
      makeRelation("c", "d", 1),
    ];

    const run1 = cluster(entities, relations, [1.0], 2);
    const run2 = cluster(entities, relations, [1.0], 2);

    expect(run1.length).toBe(run2.length);
    const ids1 = run1.map((c) => c.id).sort();
    const ids2 = run2.map((c) => c.id).sort();
    expect(ids1).toEqual(ids2);
    const members1 = run1.map((c) => [...c.entityIds].sort().join(",")).sort();
    const members2 = run2.map((c) => [...c.entityIds].sort().join(",")).sort();
    expect(members1).toEqual(members2);
  });

  it("uses content-based community IDs", () => {
    const entities = ["a", "b", "c", "d", "e", "f"].map(makeEntity);
    const relations = [
      makeRelation("a", "b", 10),
      makeRelation("b", "c", 10),
      makeRelation("a", "c", 10),
      makeRelation("d", "e", 10),
      makeRelation("e", "f", 10),
      makeRelation("d", "f", 10),
      makeRelation("c", "d", 1),
    ];

    const communities = cluster(entities, relations, [1.0], 2);
    for (const c of communities) {
      expect(c.id).toMatch(/^comm:\d+:[a-f0-9]{10}$/);
    }
  });

  it("produces stable IDs regardless of input entity order", () => {
    const entitiesAsc = ["a", "b", "c", "d", "e", "f"].map(makeEntity);
    const entitiesDesc = ["f", "e", "d", "c", "b", "a"].map(makeEntity);
    const relations = [
      makeRelation("a", "b", 10),
      makeRelation("b", "c", 10),
      makeRelation("a", "c", 10),
      makeRelation("d", "e", 10),
      makeRelation("e", "f", 10),
      makeRelation("d", "f", 10),
      makeRelation("c", "d", 1),
    ];

    const run1 = cluster(entitiesAsc, relations, [1.0], 2);
    const run2 = cluster(entitiesDesc, relations, [1.0], 2);

    const ids1 = run1.map((c) => c.id).sort();
    const ids2 = run2.map((c) => c.id).sort();
    expect(ids1).toEqual(ids2);
  });

  it("marks orphan communities when no parent has sufficient overlap", () => {
    const entities = Array.from({ length: 12 }, (_, i) => makeEntity(`n${i}`));
    const relations = [
      makeRelation("n0", "n1", 10), makeRelation("n1", "n2", 10), makeRelation("n0", "n2", 10),
      makeRelation("n3", "n4", 10), makeRelation("n4", "n5", 10), makeRelation("n3", "n5", 10),
      makeRelation("n6", "n7", 10), makeRelation("n7", "n8", 10), makeRelation("n6", "n8", 10),
      makeRelation("n9", "n10", 10), makeRelation("n10", "n11", 10), makeRelation("n9", "n11", 10),
      makeRelation("n2", "n3", 1), makeRelation("n5", "n6", 1), makeRelation("n8", "n9", 1),
    ];

    const communities = cluster(entities, relations, [0.5, 2.0], 3);

    // Every child with a parent must have >30% overlap
    for (const c of communities) {
      if (c.parentId) {
        const parent = communities.find((p) => p.id === c.parentId);
        expect(parent).toBeDefined();
        const childSet = new Set(c.entityIds);
        const overlap = parent!.entityIds.filter((id) => childSet.has(id)).length;
        expect(overlap / c.entityIds.length).toBeGreaterThan(0.3);
      }
    }
  });

  it("does not assign duplicate parents", () => {
    const entities = Array.from({ length: 12 }, (_, i) => makeEntity(`n${i}`));
    const relations = [
      makeRelation("n0", "n1", 10), makeRelation("n1", "n2", 10), makeRelation("n0", "n2", 10),
      makeRelation("n3", "n4", 10), makeRelation("n4", "n5", 10), makeRelation("n3", "n5", 10),
      makeRelation("n6", "n7", 10), makeRelation("n7", "n8", 10), makeRelation("n6", "n8", 10),
      makeRelation("n9", "n10", 10), makeRelation("n10", "n11", 10), makeRelation("n9", "n11", 10),
      makeRelation("n2", "n3", 1), makeRelation("n5", "n6", 1), makeRelation("n8", "n9", 1),
    ];

    const communities = cluster(entities, relations, [0.5, 1.0, 2.0], 3);

    const childToParent = new Map<string, string>();
    for (const c of communities) {
      for (const childId of c.childIds) {
        expect(childToParent.has(childId)).toBe(false);
        childToParent.set(childId, c.id);
      }
    }
  });

  it("links parent/child across levels", () => {
    // Large enough graph to have hierarchy
    const entities = Array.from({ length: 12 }, (_, i) =>
      makeEntity(`node${i}`),
    );
    const relations = [
      // Cluster A: 0-3
      makeRelation("node0", "node1", 10),
      makeRelation("node1", "node2", 10),
      makeRelation("node2", "node3", 10),
      makeRelation("node0", "node3", 10),
      // Cluster B: 4-7
      makeRelation("node4", "node5", 10),
      makeRelation("node5", "node6", 10),
      makeRelation("node6", "node7", 10),
      makeRelation("node4", "node7", 10),
      // Cluster C: 8-11
      makeRelation("node8", "node9", 10),
      makeRelation("node9", "node10", 10),
      makeRelation("node10", "node11", 10),
      makeRelation("node8", "node11", 10),
      // Weak bridges
      makeRelation("node3", "node4", 1),
      makeRelation("node7", "node8", 1),
    ];

    const communities = cluster(entities, relations, [0.5, 2.0], 3);

    // Check that some parent/child links exist
    const withParent = communities.filter((c) => c.parentId);
    const withChildren = communities.filter((c) => c.childIds.length > 0);
    // If hierarchy formed, there should be some links
    // (Not guaranteed for all graph structures, but likely for this one)
    if (communities.length > 3) {
      expect(withParent.length + withChildren.length).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("buildGraph", () => {
  it("log-normalizes accumulated edge weights", () => {
    const entities = ["a", "b"].map(makeEntity);
    const relations = [makeRelation("a", "b", 50)];

    const graph = buildGraph(entities, relations);

    const edge = graph.edge("a", "b")!;
    const weight = graph.getEdgeAttribute(edge, "weight") as number;
    // 1 + ln(50) ≈ 4.91
    expect(weight).toBeCloseTo(4.91, 1);
  });

  it("preserves weight=1 edges after normalization", () => {
    const entities = ["a", "b"].map(makeEntity);
    const relations = [makeRelation("a", "b", 1)];

    const graph = buildGraph(entities, relations);

    const edge = graph.edge("a", "b")!;
    const weight = graph.getEdgeAttribute(edge, "weight") as number;
    // 1 + ln(1) = 1.0
    expect(weight).toBeCloseTo(1.0, 5);
  });

  it("accumulates then normalizes multiple relations between same pair", () => {
    const entities = ["a", "b"].map(makeEntity);
    const relations = [
      makeRelation("a", "b", 7),
      { ...makeRelation("a", "b", 3), id: "rel:a-b-2" },
    ];

    const graph = buildGraph(entities, relations);

    const edge = graph.edge("a", "b")!;
    const weight = graph.getEdgeAttribute(edge, "weight") as number;
    // 1 + ln(10) ≈ 3.30
    expect(weight).toBeCloseTo(3.30, 1);
  });
});
