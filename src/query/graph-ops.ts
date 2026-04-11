import type { Store } from "../store/queries.js";
import {
  EntityType,
  RelationType,
  type Entity,
  type EntityId,
  type Relation,
} from "../shared/types.js";

// ================================================================
// Types
// ================================================================

export interface ExpertResult {
  person: Entity;
  /** Composite score: sum(authorship weights) × recencyMultiplier. Not normalized across modules. */
  score: number;
  /** Sum of AUTHORED + MODIFIED relation weights (approximate commit involvement). */
  commitCount: number;
  /** commitCount / total module frequency (0–1 range). */
  commitPercentage: number;
  lastActive: string;
  modules: string[];
}

export interface CouplingResult {
  module: Entity;
  coChangeCount: number;
  /**
   * Conditional probability P(other changed | source changed).
   * Asymmetric: getCoupling("A") and getCoupling("B") yield different ratios.
   * Computed as: co_change_weight / source_module_frequency.
   */
  coChangeRatio: number;
  sharedAuthors: string[];
}

export interface PathResult {
  path: Entity[];
  relations: Relation[];
  length: number;
}

export interface KnowledgeSiloResult {
  module: Entity;
  /** The single active expert, or null if the module is truly orphaned (0 active experts). */
  soloExpert: Entity | null;
  /** 0 = orphaned (no active expert), 1 = knowledge silo (bus factor 1). */
  activeExpertCount: number;
  lastActivity: string;
}

// ================================================================
// Graph Operations
// ================================================================

/**
 * Find the top N experts for a module (by authorship weight × recency).
 * Also searches sub-modules matching the given path prefix.
 *
 * Scoring formula:
 *   score = Σ(AUTHORED + MODIFIED relation weights) × 1/(1 + daysSinceLastActive/365)
 *
 * The recency multiplier is a hyperbolic decay: 1.0 at 0 days, 0.5 at 1 year, 0.33 at 2 years.
 * Scores are NOT normalized by module commit volume — they're comparable within a single
 * findExperts call but not meaningful across calls for different modules.
 */
export function findExperts(store: Store, modulePath: string, topN = 5): ExpertResult[] {
  // Find all module entities matching the path (exact + prefix sub-modules)
  const modules = store.findModulesByPath(modulePath);
  if (modules.length === 0) return [];

  const moduleIds = new Set(modules.map((m) => m.id));

  // Find all AUTHORED and MODIFIED relations targeting these modules
  const personScores = new Map<
    string,
    { weight: number; lastSeen: string; modules: Set<string> }
  >();

  for (const moduleId of moduleIds) {
    const relations = store.getRelationsByTarget(moduleId);

    for (const rel of relations) {
      if (rel.type !== RelationType.AUTHORED && rel.type !== RelationType.MODIFIED) continue;

      const existing = personScores.get(rel.sourceId) ?? {
        weight: 0,
        lastSeen: "",
        modules: new Set<string>(),
      };

      existing.weight += rel.weight;
      if (rel.lastSeen > existing.lastSeen) existing.lastSeen = rel.lastSeen;
      existing.modules.add(moduleId);

      personScores.set(rel.sourceId, existing);
    }
  }

  // Total module frequency for commitPercentage calculation
  const totalModuleFrequency = modules.reduce((sum, m) => sum + (m.frequency || 0), 0) || 1;

  // Score: weight × recency multiplier
  const now = new Date();
  const results: ExpertResult[] = [];

  const personIds = [...personScores.keys()];
  const personMap = store.getEntitiesByIds(personIds);

  for (const [personId, data] of personScores) {
    const person = personMap.get(personId);
    if (!person || person.type !== EntityType.PERSON) continue;

    const daysSince = data.lastSeen
      ? (now.getTime() - new Date(data.lastSeen).getTime()) / 86_400_000
      : 365;
    const recencyMultiplier = 1 / (1 + daysSince / 365);

    results.push({
      person,
      score: Math.round(data.weight * recencyMultiplier * 100) / 100,
      commitCount: data.weight, // weight ≈ commit involvement count
      commitPercentage: Math.round((data.weight / totalModuleFrequency) * 10000) / 10000,
      lastActive: data.lastSeen,
      modules: [...data.modules],
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, topN);
}

/**
 * Show modules that co-change with the given module.
 *
 * coChangeRatio is the conditional probability P(other changed | source changed),
 * computed as co_change_weight / source_module_frequency.
 * This is asymmetric: getCoupling("A") ≠ getCoupling("B").
 */
export function getCoupling(store: Store, modulePath: string, minWeight = 2): CouplingResult[] {
  // Find the target module
  const modules = store.findModulesByPath(modulePath);
  if (modules.length === 0) return [];

  const moduleIds = new Set(modules.map((m) => m.id));

  // Collect all candidate coupled module IDs and accumulate weights
  const candidateWeights = new Map<string, number>();

  for (const moduleId of moduleIds) {
    const relations = store.getRelationsForEntity(moduleId);

    for (const rel of relations) {
      if (rel.type !== RelationType.CO_CHANGED) continue;

      const otherId = rel.sourceId === moduleId ? rel.targetId : rel.sourceId;
      if (moduleIds.has(otherId)) continue;

      candidateWeights.set(otherId, (candidateWeights.get(otherId) ?? 0) + rel.weight);
    }
  }

  // Batch fetch all coupled module entities
  const otherEntities = store.getEntitiesByIds([...candidateWeights.keys()]);
  const couplingMap = new Map<string, { weight: number; moduleEntity: Entity }>();

  for (const [otherId, weight] of candidateWeights) {
    const otherEntity = otherEntities.get(otherId);
    if (otherEntity) {
      couplingMap.set(otherId, { weight, moduleEntity: otherEntity });
    }
  }

  // Compute shared authors with person name caching to avoid N+1 lookups
  const results: CouplingResult[] = [];
  const personNameCache = new Map<string, string | null>();
  const resolvePersonName = (personId: string): string | null => {
    if (!personNameCache.has(personId)) {
      const person = store.getEntity(personId);
      personNameCache.set(personId, person?.name ?? null);
    }
    return personNameCache.get(personId) ?? null;
  };

  const sourceAuthorNames = getAuthorNames(store, moduleIds, resolvePersonName);
  const sourceModuleEntities = store.getEntitiesByIds([...moduleIds]);
  const totalChanges = [...sourceModuleEntities.values()].reduce(
    (sum, e) => sum + (e.frequency ?? 0),
    0,
  );

  for (const [otherId, data] of couplingMap) {
    if (data.weight < minWeight) continue;

    const otherAuthorNames = getAuthorNames(store, new Set([otherId]), resolvePersonName);
    const shared = [...sourceAuthorNames].filter((a) => otherAuthorNames.has(a));

    results.push({
      module: data.moduleEntity,
      coChangeCount: data.weight,
      coChangeRatio: totalChanges > 0 ? data.weight / totalChanges : 0,
      sharedAuthors: shared,
    });
  }

  return results.sort((a, b) => b.coChangeCount - a.coChangeCount);
}

/**
 * BFS shortest path between two entities.
 */
export function getPath(
  store: Store,
  fromId: EntityId,
  toId: EntityId,
  maxDepth = 5,
): PathResult | null {
  if (fromId === toId) {
    const entity = store.getEntity(fromId);
    return entity ? { path: [entity], relations: [], length: 0 } : null;
  }

  // BFS
  const visited = new Set<string>([fromId]);
  const parent = new Map<string, { entityId: string; relation: Relation }>();
  let frontier = [fromId];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    for (const currentId of frontier) {
      const relations = store.getRelationsForEntity(currentId);

      for (const rel of relations) {
        const neighborId = rel.sourceId === currentId ? rel.targetId : rel.sourceId;

        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        parent.set(neighborId, { entityId: currentId, relation: rel });

        if (neighborId === toId) {
          // Reconstruct path
          return reconstructPath(store, fromId, toId, parent);
        }

        nextFrontier.push(neighborId);
      }
    }

    frontier = nextFrontier;
  }

  return null; // No path found
}

/**
 * Get entity by ID or name search (FTS fallback).
 */
export function getEntity(store: Store, query: string): Entity | null {
  // Try exact ID match
  const byId = store.getEntity(query);
  if (byId) return byId;

  // Try exact name match
  const byName = store.getEntityByName(query);
  if (byName) return byName;

  // FTS fallback
  const ftsResults = store.searchEntities(query, 1);
  return ftsResults[0] ?? null;
}

/**
 * Find modules with bus factor ≤ 1: knowledge silos (1 active expert)
 * and orphaned modules (0 active experts).
 *
 * "Active" means the author's last contribution to the module was within `inactiveDays`.
 * Modules with frequency below `minFrequency` are skipped (trivial/config files).
 */
export function findKnowledgeSilos(
  store: Store,
  options: { minFrequency?: number; inactiveDays?: number } = {},
): KnowledgeSiloResult[] {
  const { minFrequency = 3, inactiveDays = 180 } = options;

  const modules = store.getEntitiesByType(EntityType.MODULE);
  const now = new Date();
  const results: KnowledgeSiloResult[] = [];

  for (const mod of modules) {
    if (mod.frequency < minFrequency) continue;

    const rels = store.getRelationsByTarget(mod.id);
    const activeAuthors = new Map<string, true>();
    let lastActivity = "";

    for (const rel of rels) {
      if (rel.type !== RelationType.AUTHORED && rel.type !== RelationType.MODIFIED) continue;

      if (rel.lastSeen > lastActivity) lastActivity = rel.lastSeen;

      const daysSince = (now.getTime() - new Date(rel.lastSeen).getTime()) / 86_400_000;
      if (daysSince <= inactiveDays) {
        activeAuthors.set(rel.sourceId, true);
      }
    }

    if (activeAuthors.size <= 1) {
      const soloExpertId = [...activeAuthors.keys()][0];
      const soloExpert = soloExpertId ? (store.getEntity(soloExpertId) ?? null) : null;

      results.push({
        module: mod,
        soloExpert,
        activeExpertCount: activeAuthors.size,
        lastActivity,
      });
    }
  }

  // Orphaned first (0 experts), then silos (1 expert), then by frequency desc
  return results.sort((a, b) => {
    if (a.activeExpertCount !== b.activeExpertCount)
      return a.activeExpertCount - b.activeExpertCount;
    return b.module.frequency - a.module.frequency;
  });
}

// ================================================================
// Helpers
// ================================================================

/** Get author names for a set of modules, using a shared cache to avoid redundant entity lookups. */
function getAuthorNames(
  store: Store,
  moduleIds: Set<string>,
  resolvePersonName: (id: string) => string | null,
): Set<string> {
  const authors = new Set<string>();
  for (const moduleId of moduleIds) {
    const rels = store.getRelationsByTarget(moduleId);
    for (const rel of rels) {
      if (rel.type === RelationType.AUTHORED || rel.type === RelationType.MODIFIED) {
        const name = resolvePersonName(rel.sourceId);
        if (name) authors.add(name);
      }
    }
  }
  return authors;
}

function reconstructPath(
  store: Store,
  fromId: string,
  toId: string,
  parent: Map<string, { entityId: string; relation: Relation }>,
): PathResult {
  const pathIds: string[] = [toId];
  const relations: Relation[] = [];

  let current = toId;
  while (current !== fromId) {
    const prev = parent.get(current)!;
    relations.unshift(prev.relation);
    pathIds.unshift(prev.entityId);
    current = prev.entityId;
  }

  const path = pathIds.map((id) => store.getEntity(id)).filter((e): e is Entity => e !== null);

  return { path, relations, length: relations.length };
}
