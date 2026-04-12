import { createHash } from "node:crypto";
import type { Store } from "../store/queries.js";
import type { EmbeddingClient } from "../llm/embeddings.js";
import { embeddingToBuffer } from "../llm/embeddings.js";
import { logger } from "../shared/logger.js";

export interface EmbedderResult {
  entitiesEmbedded: number;
  communitiesEmbedded: number;
  entitiesSkipped: number;
  communitiesSkipped: number;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Batch-embed entities and communities, storing results in SQLite.
 *
 * This is the LAST pipeline stage — it runs after the summarizer has
 * produced final entity descriptions and community summaries.
 *
 * If `client` is null (no embedding-capable provider), returns zeros
 * immediately (graceful degradation — the graph still works without embeddings).
 */
export async function embedEntitiesAndCommunities(
  store: Store,
  client: EmbeddingClient | null,
): Promise<EmbedderResult> {
  if (!client) {
    logger.info("No embedding client — skipping embeddings");
    return {
      entitiesEmbedded: 0,
      communitiesEmbedded: 0,
      entitiesSkipped: 0,
      communitiesSkipped: 0,
    };
  }

  const stopTimer = logger.time("embedder");

  // Load existing hash map to detect unchanged items
  const existingHashesRaw = store.getMeta("embedding_hashes");
  const existingHashes: Record<string, string> = existingHashesRaw
    ? JSON.parse(existingHashesRaw)
    : {};

  const entities = store.getAllEntities();
  const communities = store.getAllCommunities();

  // Build lists of items that need (re-)embedding
  const toEmbed: Array<{ id: string; text: string; kind: "entity" | "community" }> = [];
  const newHashes: Record<string, string> = { ...existingHashes };

  let entitiesSkipped = 0;
  let communitiesSkipped = 0;

  for (const entity of entities) {
    const text = `${entity.name}: ${entity.description}`;
    const hash = hashText(text);

    if (existingHashes[entity.id] === hash) {
      entitiesSkipped++;
      continue;
    }

    newHashes[entity.id] = hash;
    toEmbed.push({ id: entity.id, text, kind: "entity" });
  }

  for (const community of communities) {
    if (!community.summary) {
      communitiesSkipped++;
      continue;
    }

    const text = `${community.title}: ${community.summary}`;
    const hash = hashText(text);

    if (existingHashes[community.id] === hash) {
      communitiesSkipped++;
      continue;
    }

    newHashes[community.id] = hash;
    toEmbed.push({ id: community.id, text, kind: "community" });
  }

  if (toEmbed.length === 0) {
    logger.info("All embeddings up to date — nothing to embed");
    stopTimer();
    return {
      entitiesEmbedded: 0,
      communitiesEmbedded: 0,
      entitiesSkipped,
      communitiesSkipped,
    };
  }

  // Single batch call for all texts
  logger.info("Embedding items", { count: toEmbed.length });
  const vectors = await client.embed(toEmbed.map((item) => item.text));

  // Store embeddings + metadata in a transaction
  let entitiesEmbedded = 0;
  let communitiesEmbedded = 0;

  store.transaction(() => {
    for (let i = 0; i < toEmbed.length; i++) {
      const item = toEmbed[i]!;
      const vec = vectors[i]!;
      const buf = embeddingToBuffer(vec);

      if (item.kind === "entity") {
        store.setEntityEmbedding(item.id, buf);
        entitiesEmbedded++;
      } else {
        store.setCommunityEmbedding(item.id, buf);
        communitiesEmbedded++;
      }
    }

    store.setMeta("embedding_hashes", JSON.stringify(newHashes));
    store.setMeta("embedding_model", `${client.provider}`);
    store.setMeta("embedding_dimensions", String(client.dimensions));
  });

  logger.info("Embedding complete", {
    entitiesEmbedded,
    communitiesEmbedded,
    entitiesSkipped,
    communitiesSkipped,
  });

  stopTimer();

  return {
    entitiesEmbedded,
    communitiesEmbedded,
    entitiesSkipped,
    communitiesSkipped,
  };
}
