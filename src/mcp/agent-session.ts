/**
 * Agent-mediated indexing session.
 *
 * When no LLM API key is available, the MCP server can fall back to a
 * two-tool protocol where the host agent performs entity extraction on
 * behalf of the pipeline:
 *
 *   1. git_oracle_index  → detects no key → reads commits, chunks them,
 *      stores session state, returns instructions.
 *   2. git_oracle_extract_next → returns the next chunk + system prompt.
 *   3. git_oracle_submit_extraction → agent submits XML, server parses
 *      and stores the result.  Repeat 2-3 until all chunks are done.
 *   4. git_oracle_extract_next returns "all done" → agent calls
 *      git_oracle_finalize_index.
 *   5. git_oracle_finalize_index → runs resolve → build → cluster,
 *      stores communities (without summaries), returns IndexResult.
 *
 * Summarization is skipped in agent-mediated mode.  Communities are
 * created with empty summaries and can be filled in later when an
 * API key becomes available (incremental re-index).
 */

import type { GitOracleConfig, CommitData, TextUnit, TextUnitId } from "../shared/types.js";
import type { ExtractorResult, ExtractedEntity, ExtractedRelation } from "../pipeline/extractor.js";
import { parseExtractionXml, SYSTEM_PROMPT } from "../pipeline/extractor.js";
import { Store } from "../store/queries.js";
import { openDatabase } from "../store/db.js";
import { resolve } from "../pipeline/resolver.js";
import { build } from "../pipeline/graph-builder.js";
import { cluster } from "../pipeline/clusterer.js";
import { resolveExtractedRelations, type IndexResult } from "../pipeline/orchestrator.js";
import { readCommits, getHead } from "../pipeline/git-reader.js";
import { chunk } from "../pipeline/chunker.js";
import { loadConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";

// ================================================================
// Session state
// ================================================================

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CHUNKS = 500;

export interface AgentIndexSession {
  config: GitOracleConfig;
  store: Store;
  textUnits: TextUnit[];
  commits: CommitData[];
  extractions: Map<TextUnitId, ExtractorResult>;
  nextIndex: number;
  createdAt: Date;
}

let activeSession: AgentIndexSession | null = null;

export function getSession(): AgentIndexSession | null {
  if (activeSession && Date.now() - activeSession.createdAt.getTime() > SESSION_TIMEOUT_MS) {
    logger.warn("agent-session: auto-clearing stale session", {
      ageMinutes: Math.round((Date.now() - activeSession.createdAt.getTime()) / 60_000),
    });
    clearSession();
  }
  return activeSession;
}

export function clearSession(): void {
  if (activeSession) {
    activeSession.store.close();
    activeSession = null;
  }
}

// ================================================================
// Phase 1: Start session (read + chunk)
// ================================================================

export async function startAgentSession(options: {
  full?: boolean;
  maxCommits?: number;
  sinceDate?: string;
}): Promise<{ chunkCount: number; commitCount: number }> {
  // Clean up any previous session
  clearSession();

  const config = loadConfig({
    maxCommits: options.maxCommits,
    sinceDate: options.sinceDate,
  });

  const db = openDatabase(config.storagePath);
  const store = new Store(db);

  // Determine incremental vs full
  let sinceCommit: string | undefined;
  if (!options.full) {
    sinceCommit = store.getMeta("last_indexed_commit") ?? undefined;
  }

  // Read commits
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
    store.close();
    return { chunkCount: 0, commitCount: 0 };
  }

  // Chunk
  const textUnits = chunk(commits, {
    commitsPerChunk: config.commitsPerChunk,
    maxChunkTokens: config.maxChunkTokens,
  });

  if (textUnits.length > MAX_CHUNKS) {
    store.close();
    throw new Error(
      `Too many chunks (${textUnits.length} > ${MAX_CHUNKS}). ` +
      `Use --max-commits to limit scope or increase commitsPerChunk.`,
    );
  }

  logger.info("agent-session: started", {
    commits: commits.length,
    textUnits: textUnits.length,
  });

  activeSession = {
    config,
    store,
    textUnits,
    commits,
    extractions: new Map(),
    nextIndex: 0,
    createdAt: new Date(),
  };

  return { chunkCount: textUnits.length, commitCount: commits.length };
}

// ================================================================
// Phase 2: Extract (one chunk at a time, driven by the host agent)
// ================================================================

export interface NextChunkResult {
  done: false;
  index: number;
  total: number;
  textUnitId: TextUnitId;
  systemPrompt: string;
  userPrompt: string;
}

export interface AllDoneResult {
  done: true;
  extracted: number;
  total: number;
}

export function getNextChunk(): NextChunkResult | AllDoneResult {
  const session = activeSession;
  if (!session) throw new Error("No active agent-mediated session");

  if (session.nextIndex >= session.textUnits.length) {
    return {
      done: true,
      extracted: session.extractions.size,
      total: session.textUnits.length,
    };
  }

  const tu = session.textUnits[session.nextIndex]!;
  return {
    done: false,
    index: session.nextIndex,
    total: session.textUnits.length,
    textUnitId: tu.id,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Extract entities and relationships from this git commit history:\n\n<commit_data>\n${tu.content}\n</commit_data>`,
  };
}

export function submitExtraction(xml: string): {
  accepted: boolean;
  entities: number;
  relations: number;
  progress: string;
} {
  const session = activeSession;
  if (!session) throw new Error("No active agent-mediated session");

  if (session.nextIndex >= session.textUnits.length) {
    return {
      accepted: false,
      entities: 0,
      relations: 0,
      progress: `All ${session.textUnits.length} chunks already processed`,
    };
  }

  const tu = session.textUnits[session.nextIndex]!;
  const result = parseExtractionXml(xml);

  session.extractions.set(tu.id, result);
  session.nextIndex++;

  logger.debug("agent-session: extraction submitted", {
    textUnitId: tu.id,
    entities: result.entities.length,
    relations: result.relations.length,
    progress: `${session.nextIndex}/${session.textUnits.length}`,
  });

  return {
    accepted: true,
    entities: result.entities.length,
    relations: result.relations.length,
    progress: `${session.nextIndex}/${session.textUnits.length}`,
  };
}

// ================================================================
// Phase 3: Finalize (resolve → build → cluster → store)
// ================================================================

export async function finalizeSession(): Promise<IndexResult> {
  const session = activeSession;
  if (!session) throw new Error("No active agent-mediated session");

  const { config, store, textUnits, commits, extractions } = session;

  try {
    // Collect all extracted entities and relations
    const allExtractedEntities: ExtractedEntity[] = [];
    const allExtractedRelations: ExtractedRelation[] = [];
    for (const result of extractions.values()) {
      allExtractedEntities.push(...result.entities);
      allExtractedRelations.push(...result.relations);
    }

    logger.info("agent-session: finalizing", {
      entities: allExtractedEntities.length,
      relations: allExtractedRelations.length,
      chunksExtracted: extractions.size,
      chunksTotal: textUnits.length,
    });

    // Resolve (deduplicate) entities
    const resolvedEntities = resolve(allExtractedEntities, {
      threshold: config.entityResolutionThreshold,
      moduleDepth: config.moduleDepth,
    });

    // Convert extracted relations to resolved relations
    const resolvedRelations = resolveExtractedRelations(
      allExtractedRelations,
      resolvedEntities,
      config.moduleDepth,
    );

    // Build graph
    build(store, {
      textUnits,
      entities: resolvedEntities,
      relations: resolvedRelations,
      extractions,
      commits,
      moduleDepth: config.moduleDepth,
    });

    // Cluster communities
    const allEntities = store.getAllEntities();
    const allRelations = store.getAllRelations();
    const communities = cluster(
      allEntities,
      allRelations,
      config.communityResolutions,
      config.minCommunitySize,
    );

    // Store communities (without summaries — agent-mediated skips summarization)
    store.transaction(() => {
      store.clearCommunities();
      for (const c of communities) {
        store.upsertCommunity(c);
      }
    });

    // Update metadata
    const lastCommit = commits[commits.length - 1]!;
    store.setMeta("last_indexed_commit", lastCommit.hash);
    store.setMeta("last_indexed_at", new Date().toISOString());
    store.setMeta(
      "head_at_index",
      await getHead(config.repoPath).catch(() => "unknown"),
    );
    store.setMeta("last_input_tokens", "0");
    store.setMeta("last_output_tokens", "0");
    store.setMeta("last_requests", String(extractions.size));
    store.setMeta("last_failures", String(textUnits.length - extractions.size));
    store.setMeta("last_cost_usd", "0");
    store.setMeta("last_provider", "agent-mediated");
    store.setMeta("last_model", "host-agent");

    const finalStats = store.getStats();

    return {
      commitsProcessed: commits.length,
      entitiesFound: finalStats.entities,
      relationsFound: finalStats.relations,
      communitiesFound: finalStats.communities,
      communitiesSummarized: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, requests: extractions.size, failures: 0 },
      actualCostUsd: 0,
    };
  } finally {
    // Always clean up
    activeSession = null;
    store.close();
  }
}
