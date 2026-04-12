import type { EmbeddingClient } from "../llm/embeddings.js";
import { cosineSimilarity, bufferToEmbedding } from "../llm/embeddings.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface SimilarityResult {
  id: string;
  similarity: number;
}

// ── Ranking helpers ────────────────────────────────────────────────────

/**
 * Compute cosine similarity of each item against queryEmbedding and return
 * results sorted descending by similarity score.
 */
export function rankBySimilarity(
  queryEmbedding: Float32Array,
  items: Array<{ id: string; embedding: Float32Array }>,
): SimilarityResult[] {
  return items
    .map((item) => ({
      id: item.id,
      similarity: cosineSimilarity(queryEmbedding, item.embedding),
    }))
    .sort((a, b) => b.similarity - a.similarity);
}

/**
 * Convenience wrapper: converts each item's Buffer embedding to Float32Array
 * via bufferToEmbedding, then delegates to rankBySimilarity.
 */
export function rankBuffersBySimilarity(
  queryEmbedding: Float32Array,
  items: Array<{ id: string; embedding: Buffer }>,
): SimilarityResult[] {
  const converted = items.map((item) => ({
    id: item.id,
    embedding: bufferToEmbedding(item.embedding),
  }));
  return rankBySimilarity(queryEmbedding, converted);
}

// ── QueryEmbedder ──────────────────────────────────────────────────────

/**
 * Wraps an EmbeddingClient with a per-query cache so that repeated calls
 * for the same query string return the exact same Float32Array reference.
 */
export class QueryEmbedder {
  private cache = new Map<string, Float32Array>();
  private client: EmbeddingClient | null;

  constructor(client: EmbeddingClient | null) {
    this.client = client;
  }

  /**
   * Embed a query string. Returns null if no client is available.
   * Repeated calls with the same string return the cached reference.
   */
  async embedQuery(query: string): Promise<Float32Array | null> {
    if (this.client === null) return null;

    const cached = this.cache.get(query);
    if (cached !== undefined) return cached;

    const [embedding] = await this.client.embed([query]);
    if (!embedding) return null;

    this.cache.set(query, embedding);
    return embedding;
  }

  /** True if an embedding client is available. */
  get isAvailable(): boolean {
    return this.client !== null;
  }
}
