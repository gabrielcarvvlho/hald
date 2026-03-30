import { UndirectedGraph } from "graphology";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import louvainModule from "graphology-communities-louvain";
const louvain = louvainModule as unknown as (
  graph: InstanceType<typeof UndirectedGraph>,
  options?: { resolution?: number; getEdgeWeight?: string | null },
) => Record<string, number>;
import type {
  Entity,
  Relation,
  Community,
  CommunityId,
} from "../shared/types.js";
import { logger } from "../shared/logger.js";

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

  if (graph.order === 0 || graph.size === 0) {
    end();
    return [];
  }

  const allCommunities: Community[] = [];

  // Run Louvain at each resolution level
  const sortedResolutions = [...resolutions].sort((a, b) => a - b);

  for (let level = 0; level < sortedResolutions.length; level++) {
    const resolution = sortedResolutions[level]!;

    const partition = louvain(graph, {
      resolution,
      getEdgeWeight: "weight",
    });

    // Group nodes by community
    const communityMembers = new Map<number, string[]>();
    for (const [nodeId, communityIdx] of Object.entries(partition)) {
      const members = communityMembers.get(communityIdx) ?? [];
      members.push(nodeId);
      communityMembers.set(communityIdx, members);
    }

    // Create Community objects, filtering by min size
    let idx = 0;
    for (const [, members] of communityMembers) {
      if (members.length < minCommunitySize) continue;

      const id: CommunityId = `comm:${level}:${idx}`;
      allCommunities.push({
        id,
        level,
        title: "",
        summary: "",
        entityIds: members,
        childIds: [],
      });
      idx++;
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

function buildGraph(entities: Entity[], relations: Relation[]): UndirectedGraph {
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
