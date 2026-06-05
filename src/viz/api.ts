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
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#06b6d4",
  "#84cc16",
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

// Truncation metadata. Present (non-null) only when the cap kicked in,
// so the client can show a "showing top N of M" badge. Null means the
// full graph fit under the caps and nothing was dropped.
export interface GraphTruncation {
  shownNodes: number;
  totalNodes: number;
  shownEdges: number;
  totalEdges: number;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: GraphCommunity[];
  // Optional in the type (so older callers/fixtures that omit it stay
  // valid) but ALWAYS set by getGraphData / the mock provider: a value
  // when the graph was capped, null when it fit. The client treats a
  // missing field the same as null.
  truncated?: GraphTruncation | null;
}

// Caps for the returned graph. Large repos produce tens of thousands of
// entities/relations; rendering every one chokes Sigma (and halos double
// the node count in the client). We return the highest-value slice — top
// nodes by frequency, top edges by weight — and report what was dropped.
export const MAX_GRAPH_NODES = 500;
export const MAX_GRAPH_EDGES = 2000;

export function getGraphData(
  store: Store,
  maxNodes: number = MAX_GRAPH_NODES,
  maxEdges: number = MAX_GRAPH_EDGES,
): GraphResponse {
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

  // ----------------------------------------------------------------
  // Node cap — keep the top-N entities by frequency. Done BEFORE layout
  // so ForceAtlas2 only spreads the survivors (cheaper + tighter spread).
  // Ties broken by id for determinism. The surviving id set then gates
  // both layout edges and the returned edge list.
  // ----------------------------------------------------------------
  const totalNodes = entities.length;
  let keptEntities = entities;
  if (entities.length > maxNodes) {
    keptEntities = [...entities]
      .sort((a, b) => {
        if (b.frequency !== a.frequency) return b.frequency - a.frequency;
        return a.id.localeCompare(b.id);
      })
      .slice(0, maxNodes);
  }
  const keptIds = new Set(keptEntities.map((e) => e.id));

  // Only relations whose BOTH endpoints survived the node cap can be
  // drawn — a dangling edge to a dropped node is meaningless.
  const survivingRelations = relations.filter(
    (r) => keptIds.has(r.sourceId) && keptIds.has(r.targetId),
  );

  // Compute layout positions over the surviving subgraph.
  const positions = computeLayout(keptEntities, survivingRelations);

  // Build nodes
  const nodes: GraphNode[] = keptEntities.map((e) => {
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
  for (const r of survivingRelations) {
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

  // ----------------------------------------------------------------
  // Edge cap — keep the top-M deduped edges by weight. totalEdges counts
  // the deduped set so the badge reads "of M relations" consistently with
  // the un-truncated response (which also returns the deduped edge list).
  // ----------------------------------------------------------------
  const dedupedEdges = Array.from(edgeMap.values());
  const totalEdges = dedupedEdges.length;
  let edges = dedupedEdges;
  if (dedupedEdges.length > maxEdges) {
    edges = [...dedupedEdges]
      .sort((a, b) => {
        if (b.weight !== a.weight) return b.weight - a.weight;
        return a.id.localeCompare(b.id);
      })
      .slice(0, maxEdges);
  }

  const truncated: GraphTruncation | null =
    nodes.length < totalNodes || edges.length < totalEdges
      ? {
          shownNodes: nodes.length,
          totalNodes,
          shownEdges: edges.length,
          totalEdges,
        }
      : null;

  return { nodes, edges, communities: communitiesWithColor, truncated };
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

  // Run ForceAtlas2 synchronously.
  //   - Very low gravity so clusters don't all melt toward the center.
  //   - High scalingRatio gives nodes large repulsion → real whitespace.
  //   - linLogMode squeezes high-degree hubs and spreads peripheral
  //     nodes more, which suits hub-and-spoke graphs like git-author /
  //     module relationships.
  //   - More iterations for small graphs so they fully settle (visual
  //     convergence matters more than raw speed at <500 nodes).
  if (graph.size > 0) {
    const n = entities.length;
    const iterations = n < 50 ? 1000 : n < 200 ? 800 : n < 1000 ? 400 : 200;
    forceAtlas2.assign(graph, {
      iterations,
      settings: {
        gravity: 0.08,
        scalingRatio: 50,
        slowDown: 8,
        linLogMode: true,
        barnesHutOptimize: n > 200,
      },
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

export function getEntityDetail(store: Store, entityId: string): EntityDetailResponse | null {
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
      direction: isOutgoing ? ("outgoing" as const) : ("incoming" as const),
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
// Community Detail (cluster explain overlay)
// ================================================================

export interface CommunityTopEntity {
  id: string;
  name: string;
  type: string;
  frequency: number;
}

export interface CommunityDetailResponse {
  id: string;
  title: string;
  summary: string;
  topEntities: CommunityTopEntity[];
}

const TOP_ENTITIES_PER_COMMUNITY = 5;

export function getCommunityDetail(
  store: Store,
  communityId: string,
): CommunityDetailResponse | null {
  const community = store.getCommunity(communityId);
  if (!community) return null;

  const entityMap = store.getEntitiesByIds(community.entityIds);
  const entities: CommunityTopEntity[] = [];
  for (const id of community.entityIds) {
    const e = entityMap.get(id);
    if (!e) continue;
    entities.push({ id: e.id, name: e.name, type: e.type, frequency: e.frequency });
  }

  // Sort by frequency desc; ties broken by name asc for deterministic ordering.
  entities.sort((a, b) => {
    if (b.frequency !== a.frequency) return b.frequency - a.frequency;
    return a.name.localeCompare(b.name);
  });

  return {
    id: community.id,
    title: community.title,
    summary: community.summary,
    topEntities: entities.slice(0, TOP_ENTITIES_PER_COMMUNITY),
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
