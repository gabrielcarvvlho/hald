/**
 * Hald — Programmatic API
 *
 * Library entry point for embedding Hald in other applications (e.g. GitHub Apps).
 * The MCP server entry point remains at src/index.ts.
 */

// Core
export { openDatabase } from "./store/db.js";
export { Store } from "./store/queries.js";
export { loadConfig } from "./shared/config.js";
export { indexRepository } from "./pipeline/orchestrator.js";

// Graph queries
export {
  findExperts,
  getCoupling,
  findKnowledgeSilos,
  getPath,
  getEntity,
} from "./query/graph-ops.js";
export { localSearch } from "./query/local-search.js";
export { globalSearch, classifyQuery } from "./query/global-search.js";

// Viz / Graph export
export { getGraphData, getEntityDetail, getStatsData } from "./viz/api.js";

// Enums (runtime values, not type-only)
export { EntityType, RelationType } from "./shared/types.js";

// Types — shared/types.ts
export type {
  Entity,
  Relation,
  Community,
  TextUnit,
  HaldConfig,
  EntityId,
  RelationId,
  CommunityId,
  TextUnitId,
  CommitHash,
  CommitData,
  FileChange,
} from "./shared/types.js";

// Types — pipeline/orchestrator.ts
export type { IndexOptions, IndexResult } from "./pipeline/orchestrator.js";

// Types — query/graph-ops.ts
export type {
  ExpertResult,
  CouplingResult,
  KnowledgeSiloResult,
  PathResult,
} from "./query/graph-ops.js";

// Types — query/local-search.ts
export type { LocalSearchOptions, LocalSearchResult } from "./query/local-search.js";

// Types — query/global-search.ts
export type { GlobalSearchOptions, GlobalSearchResult } from "./query/global-search.js";

// Types — viz/api.ts
export type {
  GraphResponse,
  GraphNode,
  GraphEdge,
  GraphCommunity,
  EntityDetailResponse,
  StatsResponse,
} from "./viz/api.js";
