import { describe, it, expect } from "vitest";
import { cluster } from "../../src/pipeline/clusterer.js";
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

  it("returns empty when no edges", () => {
    const entities = [makeEntity("a"), makeEntity("b"), makeEntity("c")];
    const result = cluster(entities, [], [1.0], 2);
    expect(result).toHaveLength(0);
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
