import type { LLMProvider } from "./types.js";
import { withRetry } from "./retry.js";
import { logger } from "../shared/logger.js";

// ── Interface ──────────────────────────────────────────────────────────

export interface EmbeddingClient {
  readonly provider: LLMProvider;
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbeddingClientConfig {
  provider: LLMProvider | "auto";
  apiKey?: string;
  baseUrl?: string;
  maxRetries: number;
}

// ── Pure math helpers ──────────────────────────────────────────────────

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

/**
 * Defensive cosine similarity. Returns null instead of throwing when the two
 * vectors have mismatched dimensions (e.g. an index built under one provider
 * queried under another). Callers treat null as "no semantic score".
 */
export function cosineSimilaritySafe(a: Float32Array, b: Float32Array): number | null {
  if (a.length !== b.length) return null;
  return cosineSimilarity(a, b);
}

/** Float32 dimension of a serialized embedding buffer (4 bytes per element). */
export function bufferDimensions(buf: Buffer): number {
  return Math.floor(buf.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

export interface RankedBuffer {
  id: string;
  similarity: number;
}

/**
 * Rank stored embedding buffers against a query vector, degrading gracefully
 * when an individual stored vector's dimension disagrees with the query (e.g.
 * the meta-level dimension check passed but a single stored vector is corrupt
 * or was written under a different model). Such vectors score 0 rather than
 * throwing "Dimension mismatch" and aborting the whole query.
 *
 * Results are sorted descending by similarity.
 */
export function rankBuffersBySimilaritySafe(
  queryEmbedding: Float32Array,
  items: Array<{ id: string; embedding: Buffer }>,
): RankedBuffer[] {
  return items
    .map((item) => {
      const score = cosineSimilaritySafe(queryEmbedding, bufferToEmbedding(item.embedding));
      // A per-vector dimension mismatch yields null → treat as "no semantic score".
      return { id: item.id, similarity: score ?? 0 };
    })
    .sort((a, b) => b.similarity - a.similarity);
}

/**
 * Resolve the dimensionality of the embeddings stored in an index. Prefers the
 * persisted `embedding_dimensions` meta value, falling back to the byte length
 * of a sample stored vector. Returns null when neither is available (no
 * embeddings indexed). Used by the query layer to detect provider mismatches
 * (e.g. an index built with OpenAI's 1536-dim vectors queried under Google's
 * 768-dim model) and gracefully fall back to FTS-only ranking.
 */
export function resolveStoredDimensions(
  metaValue: string | null,
  sampleBuffer?: Buffer,
): number | null {
  if (metaValue) {
    const parsed = Number.parseInt(metaValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (sampleBuffer) {
    const dims = bufferDimensions(sampleBuffer);
    if (dims > 0) return dims;
  }
  return null;
}

// ── Buffer serialization ───────────────────────────────────────────────

export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

export function bufferToEmbedding(buf: Buffer): Float32Array {
  // Copy to a new ArrayBuffer to guarantee alignment
  const ab = new ArrayBuffer(buf.byteLength);
  const view = new Uint8Array(ab);
  view.set(buf);
  return new Float32Array(ab);
}

// ── OpenAI embedding client ────────────────────────────────────────────

const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const OPENAI_DIMENSIONS = 1536;
// Zhipu reuses this OpenAI-compatible client but against open.bigmodel.cn, which
// has no `text-embedding-3-small`; its embedding model is `embedding-3` (2048-dim).
const ZHIPU_EMBEDDING_MODEL = "embedding-3";
const ZHIPU_DIMENSIONS = 2048;
const BATCH_SIZE = 100;

export class OpenAIEmbeddingClient implements EmbeddingClient {
  readonly provider = "openai" as const;
  readonly dimensions: number;
  readonly model: string;
  private sdk: InstanceType<typeof import("openai").default> | null = null;
  private apiKey: string;
  private baseUrl?: string;
  private maxRetries: number;

  constructor(
    apiKey: string,
    baseUrl?: string,
    maxRetries = 3,
    model: string = OPENAI_EMBEDDING_MODEL,
    dimensions: number = OPENAI_DIMENSIONS,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.maxRetries = maxRetries;
    this.model = model;
    this.dimensions = dimensions;
  }

  private async getClient() {
    if (!this.sdk) {
      const OpenAI = (await import("openai")).default;
      this.sdk = new OpenAI({
        apiKey: this.apiKey,
        maxRetries: 0, // We manage retries ourselves — prevent double-retry amplification
        timeout: 120_000,
        ...(this.baseUrl && { baseURL: this.baseUrl }),
      });
    }
    return this.sdk;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const client = await this.getClient();
    const results: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);

      const response = await withRetry(
        async () =>
          client.embeddings.create({
            model: this.model,
            input: batch,
          }),
        this.maxRetries,
        "OpenAI Embeddings",
      );

      for (const item of response.data) {
        results.push(new Float32Array(item.embedding));
      }
    }

    return results;
  }
}

// ── Google embedding client ────────────────────────────────────────────

const GOOGLE_EMBEDDING_MODEL = "text-embedding-004";
const GOOGLE_DIMENSIONS = 768;

export class GoogleEmbeddingClient implements EmbeddingClient {
  readonly provider = "google" as const;
  readonly dimensions = GOOGLE_DIMENSIONS;
  private sdk: InstanceType<typeof import("@google/genai").GoogleGenAI> | null = null;
  private apiKey: string;
  private maxRetries: number;

  constructor(apiKey: string, maxRetries = 3) {
    this.apiKey = apiKey;
    this.maxRetries = maxRetries;
  }

  private async getClient() {
    if (!this.sdk) {
      const { GoogleGenAI } = await import("@google/genai");
      this.sdk = new GoogleGenAI({ apiKey: this.apiKey });
    }
    return this.sdk;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const client = await this.getClient();
    const results: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);

      const response = await withRetry(
        async () =>
          client.models.embedContent({
            model: GOOGLE_EMBEDDING_MODEL,
            contents: batch,
          }),
        this.maxRetries,
        "Google Embeddings",
      );

      if (response.embeddings) {
        for (const emb of response.embeddings) {
          results.push(new Float32Array(emb.values ?? []));
        }
      }
    }

    return results;
  }
}

// ── Factory ────────────────────────────────────────────────────────────

/**
 * Create an embedding client for the given provider.
 * Returns null for Anthropic (no native embedding API).
 */
export async function createEmbeddingClient(
  config: EmbeddingClientConfig,
): Promise<EmbeddingClient | null> {
  const provider = config.provider === "auto" ? detectEmbeddingProvider(config.apiKey) : config.provider;

  if (provider === null) {
    logger.info("No embedding-capable provider detected — skipping embeddings");
    return null;
  }

  if (provider === "anthropic") {
    logger.info("Anthropic has no native embedding API — skipping embeddings");
    return null;
  }

  switch (provider) {
    case "openai": {
      const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) {
        logger.info("No OpenAI API key for embeddings — skipping");
        return null;
      }
      return new OpenAIEmbeddingClient(apiKey, config.baseUrl, config.maxRetries);
    }
    case "google": {
      const apiKey = config.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
      if (!apiKey) {
        logger.info("No Google API key for embeddings — skipping");
        return null;
      }
      return new GoogleEmbeddingClient(apiKey, config.maxRetries);
    }
    case "zhipu": {
      const apiKey = config.apiKey ?? process.env.ZHIPU_API_KEY;
      if (!apiKey) {
        logger.info("No Zhipu API key for embeddings — skipping");
        return null;
      }
      // Zhipu embedding API is OpenAI-compatible but exposes `embedding-3`,
      // not OpenAI's `text-embedding-3-small` — pass the right model + dims so
      // the embed call doesn't 400 on the lowest-cost indexing path.
      return new OpenAIEmbeddingClient(
        apiKey,
        config.baseUrl ?? "https://open.bigmodel.cn/api/paas/v4/",
        config.maxRetries,
        ZHIPU_EMBEDDING_MODEL,
        ZHIPU_DIMENSIONS,
      );
    }
  }
}

/**
 * Detect which embedding-capable provider is available.
 * Anthropic has no native embedding API; all others support embeddings.
 * Checks env vars first, then falls back to prefix-based inference from apiKey.
 */
function detectEmbeddingProvider(apiKey?: string): LLMProvider | null {
  // Env vars take priority
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) return "google";
  if (process.env.ZHIPU_API_KEY) return "zhipu";

  // If an explicit key was provided, infer provider from key prefix
  if (apiKey) {
    if (apiKey.startsWith("sk-")) return "openai";
    if (apiKey.startsWith("AI")) return "google";
  }

  return null;
}
