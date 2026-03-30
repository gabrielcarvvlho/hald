import type { Store } from "../store/queries.js";
import type {
  Entity,
  EntityType,
  Relation,
  TextUnit,
  Community,
} from "../shared/types.js";

// ================================================================
// Types
// ================================================================

export interface LocalSearchOptions {
  query: string;
  maxEntities?: number;
  maxRelations?: number;
  maxTextUnits?: number;
  entityTypes?: EntityType[];
}

export interface LocalSearchResult {
  entities: Entity[];
  relations: Relation[];
  textUnits: TextUnit[];
  communities: Community[];
}

// ================================================================
// Local Search
// ================================================================

/**
 * Answer entity-centric questions by finding relevant entities via FTS,
 * expanding 1-2 hops via relations, and returning supporting evidence.
 */
export function localSearch(
  store: Store,
  options: LocalSearchOptions,
): LocalSearchResult {
  const {
    query,
    maxEntities = 10,
    maxRelations = 20,
    maxTextUnits = 5,
    entityTypes,
  } = options;

  // 1. FTS search for seed entities
  let seedEntities = store.searchEntities(query, maxEntities * 2);

  // Filter by entity type if specified
  if (entityTypes && entityTypes.length > 0) {
    const typeSet = new Set(entityTypes);
    seedEntities = seedEntities.filter((e) => typeSet.has(e.type));
  }

  seedEntities = seedEntities.slice(0, maxEntities);

  if (seedEntities.length === 0) {
    return { entities: [], relations: [], textUnits: [], communities: [] };
  }

  // 2. Expand 1 hop via relations
  const entityMap = new Map(seedEntities.map((e) => [e.id, e]));
  const allRelations: Relation[] = [];
  const relSeen = new Set<string>();

  for (const entity of seedEntities) {
    const rels = store.getRelationsForEntity(entity.id);
    for (const rel of rels) {
      if (relSeen.has(rel.id)) continue;
      relSeen.add(rel.id);
      allRelations.push(rel);

      // Add the neighbor entity (1-hop expansion)
      const neighborId =
        rel.sourceId === entity.id ? rel.targetId : rel.sourceId;
      if (!entityMap.has(neighborId)) {
        const neighbor = store.getEntity(neighborId);
        if (neighbor) entityMap.set(neighborId, neighbor);
      }
    }
  }

  // 3. Collect entities, limiting total
  const entities = [...entityMap.values()].slice(0, maxEntities);

  // 4. Limit relations
  const relations = allRelations
    .sort((a, b) => b.weight - a.weight)
    .slice(0, maxRelations);

  // 5. Fetch supporting text units from seed entities
  const textUnitMap = new Map<string, TextUnit>();
  for (const entity of seedEntities) {
    if (textUnitMap.size >= maxTextUnits) break;
    const tus = store.getTextUnitsForEntity(entity.id);
    for (const tu of tus) {
      if (textUnitMap.size >= maxTextUnits) break;
      textUnitMap.set(tu.id, tu);
    }
  }

  // 6. Fetch community context for seed entities
  const communityMap = new Map<string, Community>();
  for (const entity of seedEntities) {
    const comms = store.getCommunitiesForEntity(entity.id);
    for (const c of comms) {
      communityMap.set(c.id, c);
    }
  }

  return {
    entities,
    relations,
    textUnits: [...textUnitMap.values()],
    communities: [...communityMap.values()],
  };
}
