import type {
  HaldConfig,
  CommitData,
  Entity,
  Relation,
  Community,
  CommunityId,
} from "../shared/types.js";
import type {
  ExtractedRelation,
  ExtractorResult,
  ExtractedEntity,
  TokenAccumulator,
} from "./extractor.js";
import { openDatabase } from "../store/db.js";
import { Store } from "../store/queries.js";
import { readCommits, getHead } from "./git-reader.js";
import { chunk } from "./chunker.js";
import { extractBatch } from "./extractor.js";
import { resolve } from "./resolver.js";
import { normalizeModulePath } from "./resolver.js";
import { build, generateRelationId } from "./graph-builder.js";
import { cluster, jaccardSimilarity } from "./clusterer.js";
import { summarizeBatch } from "./summarizer.js";
import { createClient, detectProvider } from "../llm/client.js";
import { createEmbeddingClient } from "../llm/embeddings.js";
import { embedEntitiesAndCommunities } from "./embedder.js";
import { calculateActualCost } from "./cost-estimator.js";
import { logger } from "../shared/logger.js";
import { safeJsonParse } from "../shared/utils.js";
import type { Presenter } from "../shared/presenter.js";

export interface IndexOptions {
  full?: boolean;
  onProgress?: (stage: string, done: number, total: number) => void;
  /**
   * Optional UI presenter for stage events. When omitted, behavior is identical
   * to before — this option is purely additive. The CLI uses this to render
   * a pretty pipeline view in TTY mode while preserving JSON-to-stderr logging
   * for non-TTY environments.
   */
  presenter?: Presenter;
}

export interface IndexResult {
  commitsProcessed: number;
  entitiesFound: number;
  relationsFound: number;
  communitiesFound: number;
  communitiesSummarized: number;
  tokenUsage: { inputTokens: number; outputTokens: number; requests: number; failures: number };
  actualCostUsd: number;
}

/**
 * Run the full indexing pipeline: read → chunk → extract → resolve → build → cluster → summarize.
 * Supports incremental indexing: only processes new commits since last_indexed_commit.
 * Smart re-summarization: only summarizes communities whose membership changed.
 */
export async function indexRepository(
  config: HaldConfig,
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
  config: HaldConfig,
  store: Store,
  options: IndexOptions,
  progress: (stage: string, done: number, total: number) => void,
): Promise<IndexResult> {
  const presenter = options.presenter;

  // 2. Determine what to index
  let sinceCommit: string | undefined;
  if (!options.full) {
    sinceCommit = store.getMeta("last_indexed_commit") ?? undefined;
  }

  // 3. Read commits
  progress("reading commits", 0, 0);
  presenter?.stageStart("reading");

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
    presenter?.stageEnd("reading", "0 commits (up to date)");
    // Resolve remaining stages so any pretty renderer doesn't hang on early-return.
    presenter?.stageEnd("chunking");
    presenter?.stageEnd("extracting");
    presenter?.stageEnd("resolving");
    presenter?.stageEnd("building");
    presenter?.stageEnd("clustering");
    presenter?.stageEnd("summarizing");
    presenter?.stageEnd("embedding");
    const stats = store.getStats();
    return {
      commitsProcessed: 0,
      entitiesFound: stats.entities,
      relationsFound: stats.relations,
      communitiesFound: stats.communities,
      communitiesSummarized: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, requests: 0, failures: 0 },
      actualCostUsd: 0,
    };
  }

  logger.info("orchestrator: commits read", { count: commits.length });
  presenter?.stageEnd("reading", `${commits.length} commits`);

  // 4. Chunk
  progress("chunking", 0, 0);
  presenter?.stageStart("chunking");
  const textUnits = chunk(commits, {
    commitsPerChunk: config.commitsPerChunk,
    maxChunkTokens: config.maxChunkTokens,
    maxDiffLines: config.maxDiffLines,
    maxFilesShown: config.maxFilesShown,
    maxMessageChars: config.maxMessageChars,
  });
  logger.info("orchestrator: chunked", { textUnits: textUnits.length });
  presenter?.stageEnd("chunking", `${textUnits.length} text units`);

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

  presenter?.stageStart("extracting");
  for await (const { textUnitId, result, failed } of extractBatch(textUnits, client, {
    concurrency: config.maxConcurrency,
    enableGleaning: true,
    gleaningMinCommits: config.gleaningMinCommits,
    gleaningMaxEntitiesRatio: config.gleaningMaxEntitiesRatio,
    onProgress: (done, total) => {
      progress("extracting", done, total);
      presenter?.stageUpdate("extracting", done, total);
    },
    tokenUsage,
  })) {
    if (failed) failedChunks++;
    extractions.set(textUnitId, result);
    allExtractedEntities.push(...result.entities);
    allExtractedRelations.push(...result.relations);
  }

  if (failedChunks > 0) {
    logger.warn(`orchestrator: ${failedChunks}/${textUnits.length} chunks failed extraction`);
    presenter?.stageWarn("extracting", `${failedChunks}/${textUnits.length} chunks failed`);
  }

  logger.info("orchestrator: extracted", {
    entities: allExtractedEntities.length,
    relations: allExtractedRelations.length,
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens,
    failedChunks,
  });
  presenter?.stageEnd(
    "extracting",
    `${allExtractedEntities.length} entities, ${allExtractedRelations.length} relations`,
  );

  // 7. Resolve (deduplicate) entities
  progress("resolving", 0, 0);
  presenter?.stageStart("resolving");
  const resolvedEntities = resolve(allExtractedEntities, {
    threshold: config.entityResolutionThreshold,
    moduleDepth: config.moduleDepth,
  });
  logger.info("orchestrator: resolved", {
    entities: resolvedEntities.length,
  });
  presenter?.stageEnd("resolving", `${resolvedEntities.length} unique entities`);

  // 8. Convert extracted relations to resolved relations (name → ID)
  const resolvedRelations = resolveExtractedRelations(
    allExtractedRelations,
    resolvedEntities,
    config.moduleDepth,
  );

  // 9. Build graph
  progress("building graph", 0, 0);
  presenter?.stageStart("building");
  build(store, {
    textUnits,
    entities: resolvedEntities,
    relations: resolvedRelations,
    extractions,
    commits,
    moduleDepth: config.moduleDepth,
  });
  presenter?.stageEnd("building");

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
  presenter?.stageStart("clustering");
  const allEntities = store.getAllEntities();
  const allRelations = store.getAllRelations();
  const communities = cluster(
    allEntities,
    allRelations,
    config.communityResolutions,
    config.minCommunitySize,
    {
      parentLinkThreshold: config.parentLinkThreshold,
      splitWarningThreshold: config.splitWarningThreshold,
    },
  );
  logger.info("orchestrator: clustered", {
    communities: communities.length,
  });
  presenter?.stageEnd("clustering", `${communities.length} communities`);

  // 12. Smart re-summarization: reuse summaries for unchanged communities
  const communitiesToSummarize: Community[] = [];

  store.transaction(() => {
    store.clearCommunities();

    for (const c of communities) {
      // Layer 1: exact match by content-based community ID
      const oldSummary = oldSummaries.get(c.id);
      if (oldSummary && oldSummary.summary) {
        c.title = oldSummary.title;
        c.summary = oldSummary.summary;
        store.upsertCommunity(c);
        continue;
      }

      // Layer 2: Jaccard fallback — find best-matching old community at same level
      let bestMatch: { id: CommunityId; jaccard: number } | null = null;
      for (const [oldId, oldMemberJson] of oldMembership) {
        if (!oldId.startsWith(`comm:${c.level}:`)) continue;
        const oldMembers: string[] = safeJsonParse(oldMemberJson, []);
        const jaccard = jaccardSimilarity(c.entityIds, oldMembers);
        if (jaccard > (bestMatch?.jaccard ?? 0)) {
          bestMatch = { id: oldId, jaccard };
        }
      }

      // Reuse summary if community membership is sufficiently similar (lower = fewer LLM calls but staler summaries)
      if (bestMatch && bestMatch.jaccard > config.summaryReuseThreshold) {
        const old = oldSummaries.get(bestMatch.id);
        if (old && old.summary) {
          c.title = old.title;
          c.summary = old.summary;
          logger.debug("orchestrator: reusing summary via Jaccard match", {
            communityId: c.id,
            matchedId: bestMatch.id,
            jaccard: bestMatch.jaccard.toFixed(2),
          });
          store.upsertCommunity(c);
          continue;
        }
      }

      communitiesToSummarize.push(c);
      store.upsertCommunity(c);
    }
  });

  const reusedCount = communities.length - communitiesToSummarize.length;
  if (reusedCount > 0) {
    logger.info("orchestrator: reusing unchanged community summaries", {
      reused: reusedCount,
      resummarize: communitiesToSummarize.length,
    });
  }

  // Summarize only the changed/new communities
  presenter?.stageStart("summarizing");
  let summarized = 0;
  if (communitiesToSummarize.length > 0) {
    presenter?.stageUpdate("summarizing", 0, communitiesToSummarize.length);
    const summarizedCommunities: Community[] = [];

    for await (const { communityId, result } of summarizeBatch(
      communitiesToSummarize,
      allEntities,
      allRelations,
      client,
      { concurrency: config.maxConcurrency, tokenUsage },
    )) {
      const community = communities.find((c) => c.id === communityId);
      if (community) {
        community.title = result.title;
        community.summary = result.summary;
        summarizedCommunities.push(community);
        summarized++;
        progress("summarizing", summarized, communitiesToSummarize.length);
        presenter?.stageUpdate("summarizing", summarized, communitiesToSummarize.length);
      }
    }

    if (summarizedCommunities.length > 0) {
      store.transaction(() => {
        for (const c of summarizedCommunities) {
          store.upsertCommunity(c);
        }
      });
    }
  }
  {
    const reusedSummaries = communities.length - communitiesToSummarize.length;
    const note =
      communitiesToSummarize.length === 0
        ? `${reusedSummaries} reused, 0 new`
        : reusedSummaries > 0
          ? `${summarized} new, ${reusedSummaries} reused`
          : `${summarized} summarized`;
    presenter?.stageEnd("summarizing", note);
  }

  // 13. Generate embeddings (optional — skipped if provider doesn't support it)
  progress("embedding", 0, 0);
  presenter?.stageStart("embedding");
  const detected = detectProvider();
  const embeddingClient = detected
    ? await createEmbeddingClient({
        provider: detected.provider,
        apiKey: config.apiKey ?? detected.apiKey,
        baseUrl: config.baseUrl,
        maxRetries: config.maxRetries,
      })
    : null;

  const embeddingResult = await embedEntitiesAndCommunities(store, embeddingClient);
  if (embeddingResult.entitiesEmbedded > 0 || embeddingResult.communitiesEmbedded > 0) {
    logger.info("orchestrator: embeddings generated", {
      entities: embeddingResult.entitiesEmbedded,
      communities: embeddingResult.communitiesEmbedded,
    });
    presenter?.stageEnd(
      "embedding",
      `${embeddingResult.entitiesEmbedded} entities, ${embeddingResult.communitiesEmbedded} communities`,
    );
  } else {
    presenter?.stageEnd("embedding", "skipped (no embedding provider)");
  }

  // 14. Update metadata
  const lastCommit = commits[commits.length - 1]!;
  store.setMeta("last_indexed_commit", lastCommit.hash);
  store.setMeta("last_indexed_at", new Date().toISOString());
  store.setMeta("head_at_index", await getHead(config.repoPath).catch(() => "unknown"));
  // Calculate actual cost from real token counts
  const cost = calculateActualCost(
    tokenUsage.inputTokens,
    tokenUsage.outputTokens,
    client.provider,
    config.model,
  );

  logger.info("orchestrator: token usage and cost", {
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens,
    requests: tokenUsage.requestCount,
    failures: tokenUsage.failedCount,
    costUsd: cost.costUsd.toFixed(4),
    model: cost.model,
  });

  store.setMeta("last_input_tokens", String(tokenUsage.inputTokens));
  store.setMeta("last_output_tokens", String(tokenUsage.outputTokens));
  store.setMeta("last_requests", String(tokenUsage.requestCount));
  store.setMeta("last_failures", String(tokenUsage.failedCount));
  store.setMeta("last_cost_usd", cost.costUsd.toFixed(6));
  store.setMeta("last_provider", cost.provider);
  store.setMeta("last_model", cost.model);

  const finalStats = store.getStats();

  return {
    commitsProcessed: commits.length,
    entitiesFound: finalStats.entities,
    relationsFound: finalStats.relations,
    communitiesFound: finalStats.communities,
    communitiesSummarized: summarized,
    tokenUsage: {
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      requests: tokenUsage.requestCount,
      failures: tokenUsage.failedCount,
    },
    actualCostUsd: cost.costUsd,
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
  moduleDepth?: number,
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
      entityByName.get(normalizeModulePath(name, moduleDepth).toLowerCase())
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
