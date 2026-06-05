import type { Store } from "../store/queries.js";
import type { Entity, EntityType, Relation, TextUnit, Community } from "../shared/types.js";
import { QueryEmbedder } from "./similarity.js";
import { resolveStoredDimensions, rankBuffersBySimilaritySafe } from "../llm/embeddings.js";
import { logger } from "../shared/logger.js";

// ================================================================
// Types
// ================================================================

export interface RankingWeights {
  fts: number;
  recency: number;
  degree: number;
}

export interface LocalSearchOptions {
  query: string;
  maxEntities?: number;
  maxRelations?: number;
  maxTextUnits?: number;
  maxTextUnitTokens?: number;
  entityTypes?: EntityType[];
  rankingWeights?: Partial<RankingWeights>;
  queryEmbedder?: QueryEmbedder;
}

export interface ScoredEntity extends Entity {
  score: number;
  isSeed: boolean;
  hopDistance: number;
  degree: number;
}

export interface AnnotatedRelation extends Relation {
  sourceName: string;
  targetName: string;
}

export interface LocalSearchResult {
  query: string;
  entities: ScoredEntity[];
  relations: AnnotatedRelation[];
  textUnits: TextUnit[];
  communities: Community[];
  totalEntityMatches: number;
  totalRelations: number;
}

// ================================================================
// Constants
// ================================================================

const DEFAULT_WEIGHTS: RankingWeights = {
  fts: 0.5,
  recency: 0.3,
  degree: 0.2,
};

// When embeddings are available, shift weight toward semantic signal
const HYBRID_WEIGHTS: RankingWeights = {
  fts: 0.25,
  recency: 0.1,
  degree: 0.05,
};
const SEMANTIC_WEIGHT = 0.6;

const SEED_ENTITY_RATIO = 0.6; // Fraction of maxEntities reserved for seeds (rest for neighbors)
const MAX_RELATIONS_PER_SEED = 15;
const MIN_RELATION_WEIGHT = 1.0;
const HOP1_BUDGET = 15;
const HOP2_BUDGET = 5;
const HOP2_TOP_NEIGHBORS = 3;
const HOP1_SCORE_DECAY = 0.5; // Max score for 1-hop neighbors (seeds score higher)
const HOP2_SCORE_DECAY = 0.25; // Max score for 2-hop neighbors

// ================================================================
// Local Search
// ================================================================

/**
 * Answer entity-centric questions by finding relevant entities via FTS,
 * scoring with a composite rank (BM25 + recency + degree centrality),
 * expanding 1-2 hops via budget-aware relation traversal, and returning
 * supporting evidence with token-budgeted text units.
 */
export async function localSearch(store: Store, options: LocalSearchOptions): Promise<LocalSearchResult> {
  const {
    query,
    maxEntities = 10,
    maxRelations = 20,
    maxTextUnits = 20,
    maxTextUnitTokens = 8000,
    entityTypes,
    rankingWeights,
  } = options;

  const now = new Date();

  // 1. FTS search with BM25 column-weighted ranking
  let rankedSeeds = store.searchEntitiesRanked(query, maxEntities * 3);

  if (entityTypes && entityTypes.length > 0) {
    const typeSet = new Set(entityTypes);
    rankedSeeds = rankedSeeds.filter((r) => typeSet.has(r.entity.type));
  }

  // Embedding-based candidates (if available)
  const semanticScores = new Map<string, number>();
  const queryEmbedding = options.queryEmbedder
    ? await options.queryEmbedder.embedQuery(query)
    : null;

  if (queryEmbedding) {
    const allEmbeddings = store.getAllEntityEmbeddings();
    if (allEmbeddings.length > 0) {
      // Guard against provider mismatch: an index built with one provider's
      // embeddings (e.g. OpenAI 1536-dim) queried under another (e.g. Google
      // 768-dim) would throw "Dimension mismatch" on every semantic query.
      // Detect it up front and fall back to FTS-only ranking instead.
      const storedDims = resolveStoredDimensions(
        store.getMeta("embedding_dimensions"),
        allEmbeddings[0]?.embedding,
      );
      if (storedDims !== null && storedDims !== queryEmbedding.length) {
        logger.warn(
          "Embedding dimension mismatch — falling back to FTS-only ranking",
          { queryDimensions: queryEmbedding.length, storedDimensions: storedDims },
        );
      } else {
        // rankBuffersBySimilaritySafe degrades a per-vector dimension mismatch
        // to a 0 score instead of throwing, so one corrupt stored vector can't
        // abort the whole query even after the meta-level guard passes.
        const ranked = rankBuffersBySimilaritySafe(queryEmbedding, allEmbeddings);
        for (const item of ranked.slice(0, maxEntities * 3)) {
          semanticScores.set(item.id, item.similarity);
        }
      }
    }
  }

  const useHybrid = semanticScores.size > 0;

  // Merge semantic-only candidates into the seed list
  if (useHybrid) {
    const ftsIds = new Set(rankedSeeds.map((r) => r.entity.id));
    for (const [entityId] of semanticScores) {
      if (ftsIds.has(entityId)) continue;
      const entity = store.getEntity(entityId);
      if (!entity) continue;
      if (entityTypes && entityTypes.length > 0 && !entityTypes.includes(entity.type)) continue;
      rankedSeeds.push({ entity, ftsRank: 0 });
    }
  }

  const totalEntityMatches = rankedSeeds.length;
  const seedLimit = Math.ceil(maxEntities * SEED_ENTITY_RATIO);
  rankedSeeds = rankedSeeds.slice(0, seedLimit);

  if (rankedSeeds.length === 0) {
    return {
      query,
      entities: [],
      relations: [],
      textUnits: [],
      communities: [],
      totalEntityMatches: 0,
      totalRelations: 0,
    };
  }

  // 2. Pre-fetch relations for scoring and expansion (reused, not fetched twice)
  const seedRelationsMap = new Map<string, Relation[]>();
  for (const { entity } of rankedSeeds) {
    seedRelationsMap.set(entity.id, store.getRelationsForEntity(entity.id));
  }

  // 3. Composite scoring: BM25 × recency × degree centrality
  const weights: RankingWeights = {
    ...(useHybrid ? HYBRID_WEIGHTS : DEFAULT_WEIGHTS),
    ...rankingWeights,
  };
  const maxDegree = Math.max(...[...seedRelationsMap.values()].map((r) => r.length), 1);

  // Adaptive BM25 normalization: divide by max absolute score in result set
  const maxAbsFtsRank = Math.max(...rankedSeeds.map(({ ftsRank }) => Math.abs(ftsRank)), 1);

  const seedScored: ScoredEntity[] = rankedSeeds.map(({ entity, ftsRank }) => {
    const degree = seedRelationsMap.get(entity.id)?.length ?? 0;
    return {
      ...entity,
      score: computeScore(entity, ftsRank, degree, maxDegree, now, weights, maxAbsFtsRank, semanticScores.get(entity.id)),
      isSeed: true,
      hopDistance: 0,
      degree,
    };
  });

  seedScored.sort((a, b) => b.score - a.score);

  // 4. Budget-aware hop expansion (1-hop + selective 2-hop)
  const expansion = expandHops(store, seedScored, seedRelationsMap, maxRelations);

  // 5. Assemble entities: seeds first, then neighbors by connection strength
  const allEntities = [...seedScored, ...expansion.neighbors].slice(0, maxEntities);
  const entityMap = new Map(allEntities.map((e) => [e.id, e]));

  // 6. Annotate relations with human-readable entity names
  const annotatedRelations = annotateRelations(expansion.relations, entityMap, store);

  // 7. Select text units: round-robin across seeds, recency-sorted, token-budgeted
  const textUnits = selectTextUnits(store, seedScored, maxTextUnits, maxTextUnitTokens);

  // 8. Community context for seed entities
  const communityMap = new Map<string, Community>();
  for (const seed of seedScored) {
    for (const c of store.getCommunitiesForEntity(seed.id)) {
      communityMap.set(c.id, c);
    }
  }

  return {
    query,
    entities: allEntities,
    relations: annotatedRelations,
    textUnits,
    communities: [...communityMap.values()],
    totalEntityMatches,
    totalRelations: expansion.totalRelations,
  };
}

// ================================================================
// Composite Scoring
// ================================================================

function computeScore(
  entity: Entity,
  ftsRank: number,
  degree: number,
  maxDegree: number,
  now: Date,
  weights: RankingWeights,
  maxAbsFtsRank: number,
  semanticScore?: number,
): number {
  // FTS: adaptive normalization — divide by max absolute BM25 score in the result set
  // BM25 scores are negative (more negative = better match), so -rank/maxAbs maps to [0, 1]
  const ftsScore = maxAbsFtsRank > 0 ? Math.max(0, Math.min(1, -ftsRank / maxAbsFtsRank)) : 0;

  // Recency: exponential decay, ~0.5 at 180 days (guard against invalid dates)
  const daysSince = (now.getTime() - new Date(entity.lastSeen).getTime()) / 86_400_000;
  const recencyScore = Number.isFinite(daysSince) ? Math.exp(-Math.max(0, daysSince) / 260) : 0;

  // Degree: log-normalized to dampen hub dominance
  const degreeScore =
    maxDegree > 1 ? Math.log(1 + degree) / Math.log(1 + maxDegree) : degree > 0 ? 1 : 0;

  let score = weights.fts * ftsScore + weights.recency * recencyScore + weights.degree * degreeScore;

  if (semanticScore !== undefined) {
    score += SEMANTIC_WEIGHT * Math.max(0, semanticScore);
  }

  return score;
}

// ================================================================
// Budget-Aware Hop Expansion
// ================================================================

interface ExpansionResult {
  neighbors: ScoredEntity[];
  relations: Relation[];
  totalRelations: number;
}

function expandHops(
  store: Store,
  seeds: ScoredEntity[],
  seedRelationsMap: Map<string, Relation[]>,
  maxRelations: number,
): ExpansionResult {
  const knownIds = new Set(seeds.map((s) => s.id));
  const allRelations: Relation[] = [];
  const relSeen = new Set<string>();

  // Total candidate relations across all seeds — computed independently of the
  // budget-limited loop below so the reported count never under-reports once
  // the hop-1 budget is exhausted (later seeds' relations still count here).
  let totalRelations = 0;
  for (const seed of seeds) {
    totalRelations += (seedRelationsMap.get(seed.id) ?? []).length;
  }

  // Collect raw neighbors with their connecting relation weight
  const rawNeighbors: Array<{
    entity: Entity;
    relWeight: number;
    hopDistance: number;
  }> = [];

  // --- 1-hop: collect neighbor IDs ---
  let hop1Budget = Math.min(HOP1_BUDGET, maxRelations);
  const hop1Pending: Array<{ neighborId: string; relWeight: number }> = [];

  for (const seed of seeds) {
    if (hop1Budget <= 0) break;
    const rels = seedRelationsMap.get(seed.id) ?? [];

    const topRels = rels
      .filter((r) => r.weight >= MIN_RELATION_WEIGHT)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_RELATIONS_PER_SEED);

    for (const rel of topRels) {
      if (hop1Budget <= 0) break;
      if (relSeen.has(rel.id)) continue;
      relSeen.add(rel.id);
      allRelations.push(rel);
      hop1Budget--;

      const neighborId = rel.sourceId === seed.id ? rel.targetId : rel.sourceId;
      if (!knownIds.has(neighborId)) {
        knownIds.add(neighborId);
        hop1Pending.push({ neighborId, relWeight: rel.weight });
      }
    }
  }

  // Batch resolve 1-hop neighbors
  const hop1EntityMap = store.getEntitiesByIds(hop1Pending.map((p) => p.neighborId));
  const hop1Entries: Array<{ entity: Entity; relWeight: number }> = [];

  for (const { neighborId, relWeight } of hop1Pending) {
    const entity = hop1EntityMap.get(neighborId);
    if (entity) {
      rawNeighbors.push({ entity, relWeight, hopDistance: 1 });
      hop1Entries.push({ entity, relWeight });
    }
  }

  // --- 2-hop: collect neighbor IDs ---
  let hop2Budget = Math.min(HOP2_BUDGET, maxRelations - allRelations.length);
  const topNeighbors = hop1Entries
    .sort((a, b) => b.relWeight - a.relWeight)
    .slice(0, HOP2_TOP_NEIGHBORS);
  const hop2Pending: Array<{ neighborId: string; relWeight: number }> = [];

  for (const { entity } of topNeighbors) {
    if (hop2Budget <= 0) break;
    const rels = store.getRelationsForEntity(entity.id);

    const topRels = rels
      .filter((r) => r.weight >= MIN_RELATION_WEIGHT * 1.5)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3);

    for (const rel of topRels) {
      if (hop2Budget <= 0) break;
      if (relSeen.has(rel.id)) continue;
      relSeen.add(rel.id);
      allRelations.push(rel);
      hop2Budget--;

      const neighborId = rel.sourceId === entity.id ? rel.targetId : rel.sourceId;
      if (!knownIds.has(neighborId)) {
        knownIds.add(neighborId);
        hop2Pending.push({ neighborId, relWeight: rel.weight });
      }
    }
  }

  // Batch resolve 2-hop neighbors
  if (hop2Pending.length > 0) {
    const hop2EntityMap = store.getEntitiesByIds(hop2Pending.map((p) => p.neighborId));
    for (const { neighborId, relWeight } of hop2Pending) {
      const entity = hop2EntityMap.get(neighborId);
      if (entity) {
        rawNeighbors.push({ entity, relWeight, hopDistance: 2 });
      }
    }
  }

  // Score neighbors: normalize by max relation weight, decay by hop distance
  const maxWeight = Math.max(...rawNeighbors.map((n) => n.relWeight), 1);
  const neighbors: ScoredEntity[] = rawNeighbors.map((n) => ({
    ...n.entity,
    score: (n.relWeight / maxWeight) * (n.hopDistance === 1 ? HOP1_SCORE_DECAY : HOP2_SCORE_DECAY),
    isSeed: false,
    hopDistance: n.hopDistance,
    degree: 0,
  }));

  return { neighbors, relations: allRelations, totalRelations };
}

// ================================================================
// Text Unit Selection (round-robin, recency-sorted, token-budgeted)
// ================================================================

function selectTextUnits(
  store: Store,
  seeds: ScoredEntity[],
  maxUnits: number,
  maxTokens: number,
): TextUnit[] {
  const candidatesByEntity = seeds.map((s) => {
    const tus = store.getTextUnitsForEntity(s.id);
    return tus.sort((a, b) => b.dateRange.end.localeCompare(a.dateRange.end));
  });

  const selected: TextUnit[] = [];
  const seen = new Set<string>();
  let tokenBudget = maxTokens;
  let round = 0;

  while (selected.length < maxUnits && tokenBudget > 0) {
    let addedThisRound = false;

    for (const candidates of candidatesByEntity) {
      if (selected.length >= maxUnits || tokenBudget <= 0) break;
      const tu = candidates[round];
      if (!tu || seen.has(tu.id)) continue;

      // ~4 chars/token is a reasonable approximation for English text with code snippets
      const tuTokens = Math.ceil(tu.content.length / 4);
      if (tuTokens > tokenBudget) continue;

      seen.add(tu.id);
      selected.push(tu);
      tokenBudget -= tuTokens;
      addedThisRound = true;
    }

    if (!addedThisRound) break;
    round++;
  }

  return selected;
}

// ================================================================
// Relation Annotation
// ================================================================

function annotateRelations(
  relations: Relation[],
  entityMap: Map<string, ScoredEntity>,
  store: Store,
): AnnotatedRelation[] {
  return relations.map((rel) => {
    const sourceName =
      entityMap.get(rel.sourceId)?.name ?? store.getEntity(rel.sourceId)?.name ?? rel.sourceId;
    const targetName =
      entityMap.get(rel.targetId)?.name ?? store.getEntity(rel.targetId)?.name ?? rel.targetId;
    return { ...rel, sourceName, targetName };
  });
}
