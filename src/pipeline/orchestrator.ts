import type { GitOracleConfig, CommitData, Entity, Relation, Community } from "../shared/types.js";
import type { ExtractedRelation, ExtractorResult, ExtractedEntity, TokenAccumulator } from "./extractor.js";
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
  communitiesSummarized: number;
}

/**
 * Run the full indexing pipeline: read → chunk → extract → resolve → build → cluster → summarize.
 * Supports incremental indexing: only processes new commits since last_indexed_commit.
 * Smart re-summarization: only summarizes communities whose membership changed.
 */
export async function indexRepository(
  config: GitOracleConfig,
  options: IndexOptions = {},
): Promise<IndexResult> {
  const end = logger.time("orchestrator: full pipeline");
  const progress = options.onProgress ?? (() => {});

  // 1. Open/create database
  const db = openDatabase(config.storagePath);
  const store = new Store(db);

  try {
    return await runPipeline(config, store, options, progress);
  } finally {
    store.close();
    end();
  }
}

async function runPipeline(
  config: GitOracleConfig,
  store: Store,
  options: IndexOptions,
  progress: (stage: string, done: number, total: number) => void,
): Promise<IndexResult> {
  // 2. Determine what to index
  let sinceCommit: string | undefined;
  if (!options.full) {
    sinceCommit = store.getMeta("last_indexed_commit") ?? undefined;
  }

  // 3. Read commits
  progress("reading commits", 0, 0);

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
    return {
      commitsProcessed: 0,
      entitiesFound: stats.entities,
      relationsFound: stats.relations,
      communitiesFound: stats.communities,
      communitiesSummarized: 0,
    };
  }

  logger.info("orchestrator: commits read", { count: commits.length });

  // 4. Chunk
  progress("chunking", 0, 0);
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
  const tokenUsage: TokenAccumulator = {
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    failedCount: 0,
  };
  let failedChunks = 0;

  for await (const { textUnitId, result, failed } of extractBatch(
    textUnits,
    client,
    {
      concurrency: config.maxConcurrency,
      onProgress: (done, total) => progress("extracting", done, total),
      tokenUsage,
    },
  )) {
    if (failed) failedChunks++;
    extractions.set(textUnitId, result);
    allExtractedEntities.push(...result.entities);
    allExtractedRelations.push(...result.relations);
  }

  if (failedChunks > 0) {
    logger.warn(
      `orchestrator: ${failedChunks}/${textUnits.length} chunks failed extraction`,
    );
  }

  logger.info("orchestrator: extracted", {
    entities: allExtractedEntities.length,
    relations: allExtractedRelations.length,
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens,
    failedChunks,
  });

  // 7. Resolve (deduplicate) entities
  progress("resolving", 0, 0);
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
  progress("building graph", 0, 0);
  build(store, {
    textUnits,
    entities: resolvedEntities,
    relations: resolvedRelations,
    extractions,
    commits,
  });

  // 10. Snapshot old communities (membership + summaries for reuse)
  const existingCommunities = [
    ...store.getCommunitiesByLevel(0),
    ...store.getCommunitiesByLevel(1),
    ...store.getCommunitiesByLevel(2),
  ];
  const oldMembership = new Map(
    existingCommunities.map((c) => [c.id, JSON.stringify([...c.entityIds].sort())]),
  );
  const oldSummaries = new Map(
    existingCommunities.map((c) => [c.id, { title: c.title, summary: c.summary }]),
  );

  // 11. Cluster communities on the full graph
  progress("clustering", 0, 0);
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

  // 12. Smart re-summarization: reuse summaries for unchanged communities
  store.clearCommunities();

  const communitiesToSummarize: Community[] = [];
  for (const c of communities) {
    const prevMembership = oldMembership.get(c.id);
    const newMembership = JSON.stringify([...c.entityIds].sort());

    if (prevMembership === newMembership) {
      // Membership unchanged — reuse old summary
      const old = oldSummaries.get(c.id);
      if (old && old.summary) {
        c.title = old.title;
        c.summary = old.summary;
      } else {
        communitiesToSummarize.push(c);
      }
    } else {
      communitiesToSummarize.push(c);
    }

    store.upsertCommunity(c);
  }

  const reusedCount = communities.length - communitiesToSummarize.length;
  if (reusedCount > 0) {
    logger.info("orchestrator: reusing unchanged community summaries", {
      reused: reusedCount,
      resummarize: communitiesToSummarize.length,
    });
  }

  // Summarize only the changed/new communities
  let summarized = 0;
  if (communitiesToSummarize.length > 0) {
    for await (const { communityId, result } of summarizeBatch(
      communitiesToSummarize,
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
        progress("summarizing", summarized, communitiesToSummarize.length);
      }
    }
  }

  // 13. Update metadata
  const lastCommit = commits[commits.length - 1]!;
  store.setMeta("last_indexed_commit", lastCommit.hash);
  store.setMeta("last_indexed_at", new Date().toISOString());
  store.setMeta(
    "head_at_index",
    await getHead(config.repoPath).catch(() => "unknown"),
  );
  store.setMeta("last_extraction_input_tokens", String(tokenUsage.inputTokens));
  store.setMeta("last_extraction_output_tokens", String(tokenUsage.outputTokens));
  store.setMeta("last_extraction_requests", String(tokenUsage.requestCount));
  store.setMeta("last_extraction_failures", String(tokenUsage.failedCount));

  const finalStats = store.getStats();

  return {
    commitsProcessed: commits.length,
    entitiesFound: finalStats.entities,
    relationsFound: finalStats.relations,
    communitiesFound: finalStats.communities,
    communitiesSummarized: summarized,
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
    if (source.id === target.id) continue;

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
