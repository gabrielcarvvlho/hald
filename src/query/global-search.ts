import type { Store } from "../store/queries.js";
import type { Community } from "../shared/types.js";

// ================================================================
// Types
// ================================================================

export interface GlobalSearchOptions {
  query: string;
  communityLevel?: number;
  maxCommunities?: number;
}

export interface GlobalSearchResult {
  communities: Community[];
}

// ================================================================
// Global Search
// ================================================================

/**
 * Answer broad, thematic questions by searching community summaries.
 * Returns ranked communities that the host agent synthesizes into a narrative.
 */
export function globalSearch(
  store: Store,
  options: GlobalSearchOptions,
): GlobalSearchResult {
  const { query, communityLevel, maxCommunities = 5 } = options;

  // If a specific level is requested, filter to that level
  if (communityLevel !== undefined) {
    const levelCommunities = store.getCommunitiesByLevel(communityLevel);
    if (levelCommunities.length === 0) {
      return { communities: [] };
    }

    // FTS search within these communities
    const ftsResults = store.searchCommunities(query, maxCommunities * 2);
    const levelIds = new Set(levelCommunities.map((c) => c.id));
    const filtered = ftsResults.filter((c) => levelIds.has(c.id));

    return {
      communities: filtered.slice(0, maxCommunities),
    };
  }

  // Default: search across all community levels
  const results = store.searchCommunities(query, maxCommunities);

  return {
    communities: results,
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
    /who (knows|owns|maintains|wrote|created|built)/i,
    /find.*(expert|owner|author|maintainer)/i,
    /what (does|is) (the|this) .* (module|file|component|service)/i,
    /show.*(coupling|dependencies|imports)/i,
    /blame/i,
  ];

  const globalPatterns = [
    /why did (we|the team|they)/i,
    /what (was|were) the (reason|decision|motivation)/i,
    /how did .* (evolve|change|migrate|grow)/i,
    /history of/i,
    /overview of/i,
    /tell me about the (architecture|codebase|system)/i,
    /what are the (main|key|major) (components|modules|areas|patterns)/i,
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
