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
export function globalSearch(store: Store, options: GlobalSearchOptions): GlobalSearchResult {
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
