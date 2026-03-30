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
  score: number;
  commitCount: number;
  lastActive: string;
  modules: string[];
}

export interface CouplingResult {
  module: Entity;
  coChangeCount: number;
  coChangeRatio: number;
  sharedAuthors: string[];
}

export interface PathResult {
  path: Entity[];
  relations: Relation[];
  length: number;
}

// ================================================================
// Graph Operations
// ================================================================

/**
 * Find the top N experts for a module (by authorship weight × recency).
 * Also searches sub-modules matching the given path prefix.
 */
export function findExperts(
  store: Store,
  modulePath: string,
  topN = 5,
): ExpertResult[] {
  // Find all module entities matching the path
  const modules = store.findModulesByPath(modulePath);
  if (modules.length === 0) {
    // Try FTS as fallback
    const ftsResults = store.searchEntities(modulePath, 5);
    const moduleResults = ftsResults.filter(
      (e) => e.type === EntityType.MODULE,
    );
    if (moduleResults.length === 0) return [];
    modules.push(...moduleResults);
  }

  const moduleIds = new Set(modules.map((m) => m.id));

  // Find all AUTHORED and MODIFIED relations targeting these modules
  const personScores = new Map<
    string,
    { weight: number; lastSeen: string; modules: Set<string> }
  >();

  for (const moduleId of moduleIds) {
    const relations = store.getRelationsByTarget(moduleId);

    for (const rel of relations) {
      if (
        rel.type !== RelationType.AUTHORED &&
        rel.type !== RelationType.MODIFIED
      )
        continue;

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

  // Score: weight × recency multiplier
  const now = new Date();
  const results: ExpertResult[] = [];

  for (const [personId, data] of personScores) {
    const person = store.getEntity(personId);
    if (!person || person.type !== EntityType.PERSON) continue;

    const daysSince = data.lastSeen
      ? (now.getTime() - new Date(data.lastSeen).getTime()) / 86_400_000
      : 365;
    const recencyMultiplier = 1 / (1 + daysSince / 365);

    results.push({
      person,
      score: Math.round(data.weight * recencyMultiplier * 100) / 100,
      commitCount: data.weight, // weight ≈ commit involvement count
      lastActive: data.lastSeen,
      modules: [...data.modules],
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, topN);
}

/**
 * Show modules that co-change with the given module.
 */
export function getCoupling(
  store: Store,
  modulePath: string,
  minWeight = 2,
): CouplingResult[] {
  // Find the target module
  const modules = store.findModulesByPath(modulePath);
  if (modules.length === 0) return [];

  const moduleIds = new Set(modules.map((m) => m.id));
  const couplingMap = new Map<
    string,
    { weight: number; moduleEntity: Entity }
  >();

  for (const moduleId of moduleIds) {
    const relations = store.getRelationsForEntity(moduleId);

    for (const rel of relations) {
      if (rel.type !== RelationType.CO_CHANGED) continue;

      const otherId =
        rel.sourceId === moduleId ? rel.targetId : rel.sourceId;
      if (moduleIds.has(otherId)) continue; // skip self-references

      const existing = couplingMap.get(otherId);
      if (existing) {
        existing.weight += rel.weight;
      } else {
        const otherEntity = store.getEntity(otherId);
        if (otherEntity) {
          couplingMap.set(otherId, { weight: rel.weight, moduleEntity: otherEntity });
        }
      }
    }
  }

  // Find shared authors between the source and coupled modules
  const results: CouplingResult[] = [];
  const sourceAuthors = getAuthors(store, moduleIds);
  const totalChanges = [...moduleIds].reduce((sum, id) => {
    const entity = store.getEntity(id);
    return sum + (entity?.frequency ?? 0);
  }, 0);

  for (const [otherId, data] of couplingMap) {
    if (data.weight < minWeight) continue;

    const otherAuthors = getAuthors(store, new Set([otherId]));
    const shared = [...sourceAuthors].filter((a) => otherAuthors.has(a));

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
        const neighborId =
          rel.sourceId === currentId ? rel.targetId : rel.sourceId;

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

// ================================================================
// Helpers
// ================================================================

function getAuthors(store: Store, moduleIds: Set<string>): Set<string> {
  const authors = new Set<string>();
  for (const moduleId of moduleIds) {
    const rels = store.getRelationsByTarget(moduleId);
    for (const rel of rels) {
      if (
        rel.type === RelationType.AUTHORED ||
        rel.type === RelationType.MODIFIED
      ) {
        const person = store.getEntity(rel.sourceId);
        if (person) authors.add(person.name);
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

  const path = pathIds
    .map((id) => store.getEntity(id))
    .filter((e): e is Entity => e !== null);

  return { path, relations, length: relations.length };
}
