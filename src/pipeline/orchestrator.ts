import type { GitOracleConfig, CommitData, Entity, Relation } from "../shared/types.js";
import type { ExtractedRelation, ExtractorResult, ExtractedEntity } from "./extractor.js";
import { openDatabase } from "../store/db.js";
import { Store } from "../store/queries.js";
import { readCommits, getHead } from "./git-reader.js";
import { chunk } from "./chunker.js";
import { extractBatch } from "./extractor.js";
import { resolve } from "./resolver.js";
import { normalizeModulePath } from "./resolver.js";
import { build, generateRelationId } from "./graph-builder.js";
import { cluster } from "./clusterer.js";
import { summarizeBatch } from "./summarizer.js";
import { createClient } from "../llm/client.js";
import { logger } from "../shared/logger.js";

export interface IndexOptions {
  full?: boolean;
  onProgress?: (stage: string, done: number, total: number) => void;
}

export interface IndexResult {
  commitsProcessed: number;
  entitiesFound: number;
  relationsFound: number;
  communitiesFound: number;
}

/**
 * Run the full indexing pipeline: read → chunk → extract → resolve → build → cluster → summarize.
 */
export async function indexRepository(
  config: GitOracleConfig,
  options: IndexOptions = {},
): Promise<IndexResult> {
  const end = logger.time("orchestrator: full pipeline");

  // 1. Open/create database
  const db = openDatabase(config.storagePath);
  const store = new Store(db);

  // 2. Determine what to index
  let sinceCommit: string | undefined;
  if (!options.full) {
    sinceCommit = store.getMeta("last_indexed_commit") ?? undefined;
  }

  // 3. Read commits
  const progress = options.onProgress ?? (() => {});
  progress("reading", 0, 0);

  const commits: CommitData[] = [];
  for await (const commit of readCommits({
    repoPath: config.repoPath,
    branch: config.branch,
    maxCommits: config.maxCommits,
    sinceDate: config.sinceDate,
    sinceCommit,
  })) {
    commits.push(commit);
  }

  if (commits.length === 0) {
    logger.info("orchestrator: no new commits to index");
    const stats = store.getStats();
    store.close();
    return {
      commitsProcessed: 0,
      entitiesFound: stats.entities,
      relationsFound: stats.relations,
      communitiesFound: stats.communities,
    };
  }

  logger.info("orchestrator: commits read", { count: commits.length });

  // 4. Chunk
  const textUnits = chunk(commits, {
    commitsPerChunk: config.commitsPerChunk,
    maxChunkTokens: config.maxChunkTokens,
  });
  logger.info("orchestrator: chunked", { textUnits: textUnits.length });

  // 5. Create LLM client
  const client = await createClient({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    maxRetries: config.maxRetries,
  });

  // 6. Extract entities and relations
  const extractions = new Map<string, ExtractorResult>();
  const allExtractedEntities: ExtractedEntity[] = [];
  const allExtractedRelations: ExtractedRelation[] = [];

  for await (const { textUnitId, result } of extractBatch(
    textUnits,
    client,
    {
      concurrency: config.maxConcurrency,
      onProgress: (done, total) => progress("extracting", done, total),
    },
  )) {
    extractions.set(textUnitId, result);
    allExtractedEntities.push(...result.entities);
    allExtractedRelations.push(...result.relations);
  }

  logger.info("orchestrator: extracted", {
    entities: allExtractedEntities.length,
    relations: allExtractedRelations.length,
  });

  // 7. Resolve (deduplicate) entities
  const resolvedEntities = resolve(
    allExtractedEntities,
    config.entityResolutionThreshold,
  );
  logger.info("orchestrator: resolved", {
    entities: resolvedEntities.length,
  });

  // 8. Convert extracted relations to resolved relations (name → ID)
  const resolvedRelations = resolveExtractedRelations(
    allExtractedRelations,
    resolvedEntities,
  );

  // 9. Build graph
  build(store, {
    textUnits,
    entities: resolvedEntities,
    relations: resolvedRelations,
    extractions,
    commits,
  });

  // 10. Cluster communities
  const allEntities = store.getAllEntities();
  const allRelations = store.getAllRelations();
  const communities = cluster(
    allEntities,
    allRelations,
    config.leidenResolutions,
    config.minCommunitySize,
  );
  logger.info("orchestrator: clustered", {
    communities: communities.length,
  });

  // 11. Summarize communities
  store.clearCommunities();
  let summarized = 0;
  for await (const { communityId, result } of summarizeBatch(
    communities,
    allEntities,
    allRelations,
    client,
    { concurrency: config.maxConcurrency },
  )) {
    const community = communities.find((c) => c.id === communityId);
    if (community) {
      community.title = result.title;
      community.summary = result.summary;
      store.upsertCommunity(community);
      summarized++;
      progress("summarizing", summarized, communities.length);
    }
  }

  // 12. Update metadata
  const lastCommit = commits[commits.length - 1]!;
  store.setMeta("last_indexed_commit", lastCommit.hash);
  store.setMeta("last_indexed_at", new Date().toISOString());
  store.setMeta(
    "head_at_index",
    await getHead(config.repoPath).catch(() => "unknown"),
  );

  const finalStats = store.getStats();
  store.close();

  end();

  return {
    commitsProcessed: commits.length,
    entitiesFound: finalStats.entities,
    relationsFound: finalStats.relations,
    communitiesFound: finalStats.communities,
  };
}

// ================================================================
// Relation resolution (extracted names → entity IDs)
// ================================================================

/**
 * Convert ExtractedRelation (entity names) → Relation (entity IDs).
 * Skips relations where source or target can't be resolved.
 */
export function resolveExtractedRelations(
  extractedRelations: ExtractedRelation[],
  resolvedEntities: Entity[],
): Relation[] {
  // Build name → entity lookup (includes aliases + normalized module paths)
  const entityByName = new Map<string, Entity>();
  for (const e of resolvedEntities) {
    entityByName.set(e.name.toLowerCase(), e);
    for (const alias of e.aliases) {
      entityByName.set(alias.toLowerCase(), e);
    }
  }

  function findEntity(name: string): Entity | undefined {
    return (
      entityByName.get(name.toLowerCase()) ??
      entityByName.get(normalizeModulePath(name).toLowerCase())
    );
  }

  const relations: Relation[] = [];
  for (const r of extractedRelations) {
    const source = findEntity(r.source);
    const target = findEntity(r.target);
    if (!source || !target) continue;
    if (source.id === target.id) continue; // skip self-loops

    const id = generateRelationId(r.type, source.id, target.id);
    relations.push({
      id,
      type: r.type,
      sourceId: source.id,
      targetId: target.id,
      weight: r.weight,
      description: r.description,
      evidence: [],
      firstSeen: "",
      lastSeen: "",
    });
  }

  return relations;
}
