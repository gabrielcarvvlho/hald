import graphologyPkg from "graphology";
const { UndirectedGraph } = graphologyPkg as unknown as { UndirectedGraph: typeof import("graphology").UndirectedGraph };
// eslint-disable-next-line @typescript-eslint/no-require-imports
import louvainModule from "graphology-communities-louvain";
const louvain = louvainModule as unknown as (
  graph: InstanceType<typeof UndirectedGraph>,
  options?: { resolution?: number; getEdgeWeight?: string | null; rng?: () => number },
) => Record<string, number>;
import graphologyComponentsPkg from "graphology-components";
const { connectedComponents } = graphologyComponentsPkg as unknown as {
  connectedComponents: (graph: InstanceType<typeof UndirectedGraph>) => string[][];
};
import type {
  Entity,
  Relation,
  Community,
  CommunityId,
} from "../shared/types.js";
import { createHash } from "crypto";
import { logger } from "../shared/logger.js";

/** Mulberry32: fast 32-bit seeded PRNG. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash sorted entity IDs into a deterministic 32-bit seed. */
function graphSeed(entityIds: string[]): number {
  const str = [...entityIds].sort().join("\0");
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h;
}

/** Content-based community ID: same entity set → same ID. */
function communityId(level: number, entityIds: string[]): CommunityId {
  const sorted = [...entityIds].sort().join("\0");
  const hash = createHash("sha256").update(sorted).digest("hex").slice(0, 10);
  return `comm:${level}:${hash}`;
}

/**
 * Run Louvain community detection at multiple resolutions.
 * Returns a flat list of communities across all levels.
 *
 * Lower resolution → fewer, larger communities.
 * Higher resolution → more, smaller communities.
 */
export function cluster(
  entities: Entity[],
  relations: Relation[],
  resolutions: number[],
  minCommunitySize: number,
): Community[] {
  if (entities.length === 0) return [];

  const end = logger.time("clusterer: detect communities");

  // Build undirected weighted graph
  const graph = buildGraph(entities, relations);

  // Guard: no edges → single community with all entities
  if (graph.order === 0 || graph.size === 0) {
    end();
    if (entities.length < minCommunitySize) return [];
    return [
      {
        id: communityId(0, entities.map((e) => e.id)),
        level: 0,
        title: "",
        summary: "",
        entityIds: entities.map((e) => e.id),
        childIds: [],
      },
    ];
  }

  // Guard: tiny graph → single-resolution run, skip hierarchy
  if (entities.length < minCommunitySize * 2) {
    const seed = graphSeed(entities.map((e) => e.id));
    const partition = louvain(graph, {
      resolution: 1.0,
      getEdgeWeight: "weight",
      rng: mulberry32(seed),
    });

    const communityMembers = new Map<number, string[]>();
    for (const [nodeId, communityIdx] of Object.entries(partition)) {
      const members = communityMembers.get(communityIdx) ?? [];
      members.push(nodeId);
      communityMembers.set(communityIdx, members);
    }

    end();
    return [...communityMembers.values()]
      .filter((members) => members.length >= minCommunitySize)
      .map((members) => ({
        id: communityId(0, members),
        level: 0,
        title: "",
        summary: "",
        entityIds: members,
        childIds: [],
      }));
  }

  // Log disconnected components for diagnostics
  const components = connectedComponents(graph);
  if (components.length > 1) {
    logger.debug("clusterer: disconnected graph", {
      components: components.length,
      sizes: components.map((c) => c.length).sort((a, b) => b - a),
    });
  }

  const allCommunities: Community[] = [];

  // Run Louvain at each resolution level
  const sortedResolutions = [...resolutions].sort((a, b) => a - b);

  const seed = graphSeed(entities.map((e) => e.id));

  for (let level = 0; level < sortedResolutions.length; level++) {
    const resolution = sortedResolutions[level]!;

    const partition = louvain(graph, {
      resolution,
      getEdgeWeight: "weight",
      rng: mulberry32(seed ^ level),
    });

    // Group nodes by community
    const communityMembers = new Map<number, string[]>();
    for (const [nodeId, communityIdx] of Object.entries(partition)) {
      const members = communityMembers.get(communityIdx) ?? [];
      members.push(nodeId);
      communityMembers.set(communityIdx, members);
    }

    // Create Community objects, filtering by min size
    for (const [, members] of communityMembers) {
      if (members.length < minCommunitySize) continue;

      allCommunities.push({
        id: communityId(level, members),
        level,
        title: "",
        summary: "",
        entityIds: members,
        childIds: [],
      });
    }
  }

  // Link parent/child across levels
  linkHierarchy(allCommunities);

  end();
  logger.info("clusterer: done", {
    levels: sortedResolutions.length,
    communities: allCommunities.length,
  });

  return allCommunities;
}

// ================================================================
// Graph construction
// ================================================================

export function buildGraph(entities: Entity[], relations: Relation[]): UndirectedGraph {
  const graph = new UndirectedGraph();

  for (const entity of entities) {
    graph.addNode(entity.id);
  }

  const nodeSet = new Set(entities.map((e) => e.id));

  for (const relation of relations) {
    if (!nodeSet.has(relation.sourceId) || !nodeSet.has(relation.targetId))
      continue;
    if (relation.sourceId === relation.targetId) continue;

    if (graph.hasEdge(relation.sourceId, relation.targetId)) {
      const edge = graph.edge(relation.sourceId, relation.targetId)!;
      const w = (graph.getEdgeAttribute(edge, "weight") as number) ?? 0;
      graph.setEdgeAttribute(edge, "weight", w + relation.weight);
    } else {
      graph.addEdge(relation.sourceId, relation.targetId, {
        weight: relation.weight,
      });
    }
  }

  // Log-normalize edge weights to dampen high-frequency CO_CHANGED dominance
  graph.forEachEdge((edge) => {
    const w = graph.getEdgeAttribute(edge, "weight") as number;
    graph.setEdgeAttribute(edge, "weight", 1 + Math.log(Math.max(w, 1)));
  });

  return graph;
}

// ================================================================
// Hierarchy linking
// ================================================================

function linkHierarchy(communities: Community[]): void {
  // Group by level
  const byLevel = new Map<number, Community[]>();
  for (const c of communities) {
    const level = byLevel.get(c.level) ?? [];
    level.push(c);
    byLevel.set(c.level, level);
  }

  const levels = [...byLevel.keys()].sort((a, b) => a - b);

  // For each pair of adjacent levels, link parent ↔ child
  for (let i = 0; i < levels.length - 1; i++) {
    const childLevel = byLevel.get(levels[i]!)!;
    const parentLevel = byLevel.get(levels[i + 1]!)!;

    for (const child of childLevel) {
      const childSet = new Set(child.entityIds);

      // Find the parent with the most overlap
      let bestParent: Community | null = null;
      let bestOverlap = 0;

      for (const parent of parentLevel) {
        const overlap = parent.entityIds.filter((id) =>
          childSet.has(id),
        ).length;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestParent = parent;
        }
      }

      if (bestParent && bestOverlap > 0) {
        child.parentId = bestParent.id;
        bestParent.childIds.push(child.id);
      }
    }
  }
}
