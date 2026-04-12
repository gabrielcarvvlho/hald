import type { Store } from "../store/queries.js";
import type { Entity, Community } from "../shared/types.js";
import { QueryEmbedder, rankBuffersBySimilarity } from "./similarity.js";

// ================================================================
// Types
// ================================================================

export interface GlobalSearchOptions {
  query: string;
  communityLevel?: number;
  maxCommunities?: number;
  queryEmbedder?: QueryEmbedder;
}

export interface GlobalSearchResult {
  communities: Community[];
  topEntities: Entity[];
  totalCommunities: number;
}

// ================================================================
// Constants
// ================================================================

const SEMANTIC_WEIGHT = 0.6;
const FTS_WEIGHT = 0.4;
const FTS_CANDIDATE_MULTIPLIER = 5;

// ================================================================
// Global Search
// ================================================================

/**
 * Answer broad, thematic questions by searching community summaries.
 * Returns ranked communities that the host agent synthesizes into a narrative.
 * When embeddings are available, uses hybrid scoring (semantic + FTS).
 */
export async function globalSearch(
  store: Store,
  options: GlobalSearchOptions,
): Promise<GlobalSearchResult> {
  const { query, communityLevel, maxCommunities = 5 } = options;

  // Cheap count — avoids loading all community rows
  const totalCommunities = store.getCommunityCount();

  // Get top entities matching the query for additional context
  const topEntityResults = store.searchEntitiesRanked(query, 5);
  const topEntities = topEntityResults.map((r) => r.entity);

  // Embedding-based community ranking (if available)
  const semanticScores = new Map<string, number>();
  const queryEmbedding = options.queryEmbedder
    ? await options.queryEmbedder.embedQuery(query)
    : null;

  if (queryEmbedding) {
    const communityEmbeddings = store.getAllCommunityEmbeddings();
    if (communityEmbeddings.length > 0) {
      const ranked = rankBuffersBySimilarity(queryEmbedding, communityEmbeddings);
      for (const item of ranked) {
        semanticScores.set(item.id, item.similarity);
      }
    }
  }

  const useHybrid = semanticScores.size > 0;

  // If a specific level is requested, filter to that level
  if (communityLevel !== undefined) {
    const levelCommunities = store.getCommunitiesByLevel(communityLevel);
    if (levelCommunities.length === 0) {
      return { communities: [], topEntities, totalCommunities };
    }

    if (useHybrid) {
      const ftsLimit = Math.max(maxCommunities * FTS_CANDIDATE_MULTIPLIER, levelCommunities.length);
      const ftsResults = store.searchCommunities(query, ftsLimit);
      const ftsRankMap = new Map<string, number>();
      ftsResults.forEach((c, i) => ftsRankMap.set(c.id, i));

      const levelIds = new Set(levelCommunities.map((c) => c.id));
      const scored = levelCommunities
        .filter((c) => levelIds.has(c.id))
        .map((c) => {
          const semantic = semanticScores.get(c.id) ?? 0;
          const ftsIdx = ftsRankMap.get(c.id);
          const ftsScore =
            ftsIdx !== undefined ? 1 - ftsIdx / Math.max(ftsResults.length, 1) : 0;
          return {
            community: c,
            score: SEMANTIC_WEIGHT * Math.max(0, semantic) + FTS_WEIGHT * ftsScore,
          };
        })
        .sort((a, b) => b.score - a.score);

      return {
        communities: scored.slice(0, maxCommunities).map((s) => s.community),
        topEntities,
        totalCommunities,
      };
    }

    // FTS-only for specific level
    const ftsResults = store.searchCommunities(query, maxCommunities * 2);
    const levelIds = new Set(levelCommunities.map((c) => c.id));
    const filtered = ftsResults.filter((c) => levelIds.has(c.id));

    return {
      communities: filtered.slice(0, maxCommunities),
      topEntities,
      totalCommunities,
    };
  }

  // Default: search across all community levels
  if (useHybrid) {
    // Cap FTS at a reasonable limit instead of loading all
    const ftsLimit = maxCommunities * FTS_CANDIDATE_MULTIPLIER;
    const ftsResults = store.searchCommunities(query, ftsLimit);
    const ftsRankMap = new Map<string, number>();
    ftsResults.forEach((c, i) => ftsRankMap.set(c.id, i));

    // Score all communities that have either a semantic score or FTS match
    const candidateIds = new Set([...semanticScores.keys(), ...ftsResults.map((c) => c.id)]);

    // Only load full communities for the candidates we need to score
    const allCommunities = store.getAllCommunities();
    const communityMap = new Map(allCommunities.map((c) => [c.id, c]));
    const scored = [...candidateIds]
      .map((id) => {
        const community = communityMap.get(id);
        if (!community) return null;
        const semantic = semanticScores.get(id) ?? 0;
        const ftsIdx = ftsRankMap.get(id);
        const ftsScore =
          ftsIdx !== undefined ? 1 - ftsIdx / Math.max(ftsResults.length, 1) : 0;
        return {
          community,
          score: SEMANTIC_WEIGHT * Math.max(0, semantic) + FTS_WEIGHT * ftsScore,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => b.score - a.score);

    return {
      communities: scored.slice(0, maxCommunities).map((s) => s.community),
      topEntities,
      totalCommunities,
    };
  }

  // FTS-only fallback
  const results = store.searchCommunities(query, maxCommunities);

  return {
    communities: results,
    topEntities,
    totalCommunities,
  };
}

// ================================================================
// Query Classification
// ================================================================

/**
 * Heuristic to decide between local and global search.
 * Local = entity-centric (who/what), Global = thematic (why/how/overview).
 */
export function classifyQuery(question: string): "local" | "global" {
  const localPatterns = [
    /who (knows|owns|maintains|wrote|created|built|works on|is responsible)/i,
    /who (has been|is|was) (working|contributing|committing)/i,
    /which (people|developers|engineers|contributors|authors)/i,
    /find.*(expert|owner|author|maintainer)/i,
    /what (does|is) (the|this) .* (module|file|component|service)/i,
    /show.*(coupling|dependencies|imports)/i,
    /when (did|was|were) .* (added?|created?|introduced?|removed?|changed?)/i,
    /where is/i,
    /blame/i,
  ];

  const globalPatterns = [
    /why did (we|the team|they)/i,
    /what('s| is| was| were) the .*(strategy|approach|philosophy|policy|convention)/i,
    /what (was|were) the (reason|decision|motivation)/i,
    /how did .* (evolve|change|migrate|grow)/i,
    /how (does|do|is|are) .* (organized|structured|laid out)/i,
    /history of/i,
    /overview of/i,
    /summarize|summary of|describe the/i,
    /tell me about the (architecture|codebase|system|project|repo)/i,
    /what are the (main|key|major|primary) /i,
    /what(?:'s| is| are)? (?:the |our )?(technologies|tech|tools|stack|frameworks|languages)/i,
    /what patterns/i,
    /big picture|bird.?s?.?eye|high.?level/i,
  ];

  for (const pattern of localPatterns) {
    if (pattern.test(question)) return "local";
  }
  for (const pattern of globalPatterns) {
    if (pattern.test(question)) return "global";
  }

  // Default to local — most questions are about specific things
  return "local";
}
