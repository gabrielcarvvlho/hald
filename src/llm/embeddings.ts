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
const BATCH_SIZE = 100;

export class OpenAIEmbeddingClient implements EmbeddingClient {
  readonly provider = "openai" as const;
  readonly dimensions = OPENAI_DIMENSIONS;
  private sdk: InstanceType<typeof import("openai").default> | null = null;
  private apiKey: string;
  private baseUrl?: string;
  private maxRetries: number;

  constructor(apiKey: string, baseUrl?: string, maxRetries = 3) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.maxRetries = maxRetries;
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
            model: OPENAI_EMBEDDING_MODEL,
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
  }
}

/**
 * Detect which embedding-capable provider is available.
 * Only OpenAI and Google support embeddings; Anthropic does not.
 */
function detectEmbeddingProvider(apiKey?: string): LLMProvider | null {
  // If an explicit key was provided, check OpenAI first then Google
  if (apiKey) {
    if (process.env.OPENAI_API_KEY) return "openai";
    if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) return "google";
  }

  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) return "google";

  return null;
}
