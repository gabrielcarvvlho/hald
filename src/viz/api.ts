import graphologyPkg from "graphology";
const { UndirectedGraph } = graphologyPkg as unknown as {
  UndirectedGraph: typeof import("graphology").UndirectedGraph;
};
import fa2Module from "graphology-layout-forceatlas2";
const forceAtlas2 = fa2Module as unknown as {
  assign(
    graph: InstanceType<typeof UndirectedGraph>,
    options: { iterations: number; settings?: Record<string, unknown> },
  ): void;
};
import type { Store } from "../store/queries.js";
import type { Entity, Relation } from "../shared/types.js";

const COMMUNITY_COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#14b8a6", "#f97316", "#06b6d4", "#84cc16",
];

// ================================================================
// Graph Data (full graph for Sigma.js)
// ================================================================

export interface GraphNode {
  id: string;
  type: string;
  name: string;
  description: string;
  frequency: number;
  lastSeen: string;
  communityId: string | null;
  x: number;
  y: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
  description: string;
}

export interface GraphCommunity {
  id: string;
  title: string;
  summary: string;
  color: string;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: GraphCommunity[];
}

export function getGraphData(store: Store): GraphResponse {
  const entities = store.getAllEntities();
  const relations = store.getAllRelations();
  const communities = store.getCommunitiesByLevel(0);

  // Assign colors to communities
  const communityColorMap = new Map<string, string>();
  const communitiesWithColor: GraphCommunity[] = communities.map((c, i) => {
    const color = COMMUNITY_COLORS[i % COMMUNITY_COLORS.length];
    communityColorMap.set(c.id, color);
    return { id: c.id, title: c.title, summary: c.summary, color };
  });

  // Map entity → first community at level 0
  const entityCommunityMap = new Map<string, string>();
  for (const c of communities) {
    for (const eid of c.entityIds) {
      if (!entityCommunityMap.has(eid)) {
        entityCommunityMap.set(eid, c.id);
      }
    }
  }

  // Compute layout positions
  const positions = computeLayout(entities, relations);

  // Build nodes
  const nodes: GraphNode[] = entities.map((e) => {
    const pos = positions.get(e.id) ?? { x: 0, y: 0 };
    return {
      id: e.id,
      type: e.type,
      name: e.name,
      description: e.description,
      frequency: e.frequency,
      lastSeen: e.lastSeen,
      communityId: entityCommunityMap.get(e.id) ?? null,
      x: pos.x,
      y: pos.y,
    };
  });

  // Deduplicate edges: for each undirected (source, target) pair, keep highest weight
  const edgeMap = new Map<string, GraphEdge>();
  for (const r of relations) {
    const key = [r.sourceId, r.targetId].sort().join("\0");
    const existing = edgeMap.get(key);
    if (!existing || r.weight > existing.weight) {
      edgeMap.set(key, {
        id: r.id,
        source: r.sourceId,
        target: r.targetId,
        type: r.type,
        weight: r.weight,
        description: r.description,
      });
    }
  }
  const edges = Array.from(edgeMap.values());

  return { nodes, edges, communities: communitiesWithColor };
}

function computeLayout(
  entities: Entity[],
  relations: Relation[],
): Map<string, { x: number; y: number }> {
  if (entities.length === 0) return new Map();

  const graph = new UndirectedGraph();

  // Add nodes with deterministic initial positions (seeded from entity ID)
  for (const e of entities) {
    let hash = 0;
    for (let i = 0; i < e.id.length; i++) {
      hash = ((hash << 5) - hash + e.id.charCodeAt(i)) | 0;
    }
    graph.addNode(e.id, {
      x: ((hash & 0xffff) / 0xffff) * 100 - 50,
      y: (((hash >> 16) & 0xffff) / 0xffff) * 100 - 50,
    });
  }

  // Add edges (merge parallel edges by summing log-normalized weight)
  for (const r of relations) {
    if (!graph.hasNode(r.sourceId) || !graph.hasNode(r.targetId)) continue;
    if (r.sourceId === r.targetId) continue; // skip self-loops

    const logWeight = 1 + Math.log(r.weight + 1);
    if (graph.hasEdge(r.sourceId, r.targetId)) {
      const key = graph.edge(r.sourceId, r.targetId)!;
      const w = graph.getEdgeAttribute(key, "weight") as number;
      graph.setEdgeAttribute(key, "weight", w + logWeight);
    } else {
      graph.addEdge(r.sourceId, r.targetId, { weight: logWeight });
    }
  }

  // Run ForceAtlas2 synchronously
  if (graph.size > 0) {
    forceAtlas2.assign(graph, {
      iterations: entities.length < 100 ? 200 : 100,
      settings: { gravity: 1, scalingRatio: 10, barnesHutOptimize: entities.length > 200 },
    });
  }

  const positions = new Map<string, { x: number; y: number }>();
  graph.forEachNode((node: string, attrs: Record<string, unknown>) => {
    positions.set(node, { x: attrs.x as number, y: attrs.y as number });
  });

  return positions;
}

// ================================================================
// Entity Detail (sidebar)
// ================================================================

export interface EntityDetailRelation {
  id: string;
  type: string;
  targetId: string;
  targetName: string;
  targetType: string;
  weight: number;
  description: string;
  direction: "outgoing" | "incoming";
}

export interface EntityDetailResponse {
  entity: {
    id: string;
    type: string;
    name: string;
    description: string;
    aliases: string[];
    frequency: number;
    firstSeen: string;
    lastSeen: string;
  };
  relations: EntityDetailRelation[];
  communities: Array<{ id: string; title: string; summary: string }>;
  recentCommits: Array<{
    hash: string;
    message: string;
    date: string;
    authorName: string;
  }>;
}

export function getEntityDetail(
  store: Store,
  entityId: string,
): EntityDetailResponse | null {
  const entity = store.getEntity(entityId);
  if (!entity) return null;

  // Relations with target entity details
  const relations = store.getRelationsForEntity(entityId);
  const relatedIds = new Set(relations.flatMap((r) => [r.sourceId, r.targetId]));
  relatedIds.delete(entityId);
  const relatedEntities = store.getEntitiesByIds(Array.from(relatedIds));

  const annotatedRelations: EntityDetailRelation[] = relations.map((r) => {
    const isOutgoing = r.sourceId === entityId;
    const otherId = isOutgoing ? r.targetId : r.sourceId;
    const other = relatedEntities.get(otherId);
    return {
      id: r.id,
      type: r.type,
      targetId: otherId,
      targetName: other?.name ?? otherId,
      targetType: other?.type ?? "UNKNOWN",
      weight: r.weight,
      description: r.description,
      direction: isOutgoing ? "outgoing" as const : "incoming" as const,
    };
  });

  // Sort by weight desc
  annotatedRelations.sort((a, b) => b.weight - a.weight);

  // Communities
  const communities = store.getCommunitiesForEntity(entityId).map((c) => ({
    id: c.id,
    title: c.title,
    summary: c.summary,
  }));

  // Recent commits via text units
  const textUnits = store.getTextUnitsForEntity(entityId);
  const commitHashes = new Set<string>();
  for (const tu of textUnits) {
    for (const hash of tu.commitHashes) {
      commitHashes.add(hash);
    }
  }

  const commits: Array<{ hash: string; message: string; date: string; authorName: string }> = [];
  for (const hash of commitHashes) {
    const commit = store.getCommit(hash);
    if (commit) {
      commits.push({
        hash: commit.hash.slice(0, 7),
        message: commit.message.split("\n")[0].slice(0, 80),
        date: commit.date,
        authorName: commit.authorName,
      });
    }
  }
  commits.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return {
    entity: {
      id: entity.id,
      type: entity.type,
      name: entity.name,
      description: entity.description,
      aliases: entity.aliases,
      frequency: entity.frequency,
      firstSeen: entity.firstSeen,
      lastSeen: entity.lastSeen,
    },
    relations: annotatedRelations,
    communities,
    recentCommits: commits.slice(0, 10),
  };
}

// ================================================================
// Stats (header)
// ================================================================

export interface StatsResponse {
  entities: number;
  relations: number;
  communities: number;
  commits: number;
  lastIndexedAt: string | null;
}

export function getStatsData(store: Store): StatsResponse {
  const stats = store.getStats();
  return {
    entities: stats.entities,
    relations: stats.relations,
    communities: stats.communities,
    commits: stats.commits,
    lastIndexedAt: store.getMeta("last_indexed_at"),
  };
}
