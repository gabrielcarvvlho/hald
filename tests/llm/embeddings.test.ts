import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  cosineSimilarity,
  cosineSimilaritySafe,
  bufferDimensions,
  resolveStoredDimensions,
  embeddingToBuffer,
  bufferToEmbedding,
  rankBuffersBySimilaritySafe,
  createEmbeddingClient,
  OpenAIEmbeddingClient,
  GoogleEmbeddingClient,
} from "../../src/llm/embeddings.js";

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("returns -1.0 for opposite vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("returns high score for similar vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1.1, 2.1, 3.1]);
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.99);
    expect(sim).toBeLessThanOrEqual(1.0);
  });

  it("returns 0 when a vector is all zeros", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("throws on dimension mismatch", () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(() => cosineSimilarity(a, b)).toThrow("Dimension mismatch");
  });
});

describe("cosineSimilaritySafe", () => {
  it("matches cosineSimilarity when dimensions agree", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilaritySafe(a, b)).toBeCloseTo(cosineSimilarity(a, b), 5);
  });

  it("returns null on dimension mismatch instead of throwing", () => {
    const a = new Float32Array([1, 2]); // 2-dim
    const b = new Float32Array([1, 2, 3]); // 3-dim
    expect(() => cosineSimilaritySafe(a, b)).not.toThrow();
    expect(cosineSimilaritySafe(a, b)).toBeNull();
  });
});

describe("rankBuffersBySimilaritySafe", () => {
  it("ranks matching-dimension buffers descending by similarity", () => {
    const query = new Float32Array([1, 0, 0]);
    const items = [
      { id: "orthogonal", embedding: embeddingToBuffer(new Float32Array([0, 1, 0])) },
      { id: "identical", embedding: embeddingToBuffer(new Float32Array([1, 0, 0])) },
      { id: "similar", embedding: embeddingToBuffer(new Float32Array([0.9, 0.1, 0])) },
    ];

    const ranked = rankBuffersBySimilaritySafe(query, items);
    expect(ranked.map((r) => r.id)).toEqual(["identical", "similar", "orthogonal"]);
    expect(ranked[0]!.similarity).toBeCloseTo(1.0, 5);
  });

  it("degrades a per-vector dimension mismatch to score 0 instead of throwing", () => {
    const query = new Float32Array([1, 0, 0]); // 3-dim
    const items = [
      // A single corrupt/foreign-dimension stored vector must not abort ranking.
      { id: "wrong-dim", embedding: embeddingToBuffer(new Float32Array([1, 0])) }, // 2-dim
      { id: "good", embedding: embeddingToBuffer(new Float32Array([1, 0, 0])) }, // 3-dim
    ];

    expect(() => rankBuffersBySimilaritySafe(query, items)).not.toThrow();
    const ranked = rankBuffersBySimilaritySafe(query, items);
    // The matching vector ranks first; the mismatched one scores 0.
    expect(ranked[0]!.id).toBe("good");
    expect(ranked.find((r) => r.id === "wrong-dim")!.similarity).toBe(0);
  });

  it("returns an empty array for empty input", () => {
    expect(rankBuffersBySimilaritySafe(new Float32Array([1, 0, 0]), [])).toEqual([]);
  });
});

describe("bufferDimensions", () => {
  it("returns the Float32 element count of a serialized embedding", () => {
    expect(bufferDimensions(embeddingToBuffer(new Float32Array([1, 2, 3])))).toBe(3);
    expect(bufferDimensions(embeddingToBuffer(new Float32Array(1536)))).toBe(1536);
    expect(bufferDimensions(embeddingToBuffer(new Float32Array([])))).toBe(0);
  });
});

describe("resolveStoredDimensions", () => {
  it("prefers the persisted meta value when present", () => {
    expect(resolveStoredDimensions("1536")).toBe(1536);
    // Meta wins even if a (stale) sample buffer disagrees
    expect(resolveStoredDimensions("768", embeddingToBuffer(new Float32Array(1536)))).toBe(768);
  });

  it("falls back to the sample buffer byte length when meta is absent", () => {
    expect(resolveStoredDimensions(null, embeddingToBuffer(new Float32Array(768)))).toBe(768);
  });

  it("returns null when neither meta nor a sample buffer is available", () => {
    expect(resolveStoredDimensions(null)).toBeNull();
  });

  it("ignores non-positive or non-numeric meta and falls back", () => {
    expect(resolveStoredDimensions("0", embeddingToBuffer(new Float32Array(4)))).toBe(4);
    expect(resolveStoredDimensions("abc", embeddingToBuffer(new Float32Array(4)))).toBe(4);
    expect(resolveStoredDimensions("abc")).toBeNull();
  });
});

describe("embeddingToBuffer / bufferToEmbedding", () => {
  it("roundtrip preserves values", () => {
    const original = new Float32Array([0.1, -0.5, 3.14, 0, -1e-7, 999.999]);
    const buf = embeddingToBuffer(original);
    const restored = bufferToEmbedding(buf);

    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i]!, 5);
    }
  });

  it("roundtrip works with empty array", () => {
    const original = new Float32Array([]);
    const buf = embeddingToBuffer(original);
    const restored = bufferToEmbedding(buf);
    expect(restored.length).toBe(0);
  });

  it("produces a Buffer of correct byte length", () => {
    const vec = new Float32Array([1, 2, 3]);
    const buf = embeddingToBuffer(vec);
    // Float32 = 4 bytes per element
    expect(buf.byteLength).toBe(12);
  });
});

describe("createEmbeddingClient", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("returns null for anthropic provider", async () => {
    const client = await createEmbeddingClient({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      maxRetries: 1,
    });
    expect(client).toBeNull();
  });

  it("creates OpenAI client with correct dimensions", async () => {
    const client = await createEmbeddingClient({
      provider: "openai",
      apiKey: "sk-openai-test",
      maxRetries: 1,
    });
    expect(client).toBeInstanceOf(OpenAIEmbeddingClient);
    expect(client!.provider).toBe("openai");
    expect(client!.dimensions).toBe(1536);
  });

  it("creates a Zhipu client with its own embedding model and dimensions", async () => {
    const client = await createEmbeddingClient({
      provider: "zhipu",
      apiKey: "zhipu-test",
      maxRetries: 1,
    });
    expect(client).toBeInstanceOf(OpenAIEmbeddingClient);
    // Zhipu reuses the OpenAI-compatible client, but open.bigmodel.cn has no
    // `text-embedding-3-small` — it must use `embedding-3`, or the embed pass 400s.
    const zhipu = client as OpenAIEmbeddingClient;
    expect(zhipu.model).toBe("embedding-3");
    expect(zhipu.dimensions).toBe(2048);
  });

  it("creates Google client with correct dimensions", async () => {
    const client = await createEmbeddingClient({
      provider: "google",
      apiKey: "google-test",
      maxRetries: 1,
    });
    expect(client).toBeInstanceOf(GoogleEmbeddingClient);
    expect(client!.provider).toBe("google");
    expect(client!.dimensions).toBe(768);
  });

  it("returns null when auto and no embedding-capable keys", async () => {
    // Only anthropic key set — can't embed
    const client = await createEmbeddingClient({
      provider: "auto",
      maxRetries: 1,
    });
    expect(client).toBeNull();
  });

  it("auto-detects OpenAI when OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-auto";
    const client = await createEmbeddingClient({
      provider: "auto",
      maxRetries: 1,
    });
    expect(client).toBeInstanceOf(OpenAIEmbeddingClient);
    expect(client!.dimensions).toBe(1536);
  });

  it("auto-detects Google when only GOOGLE_API_KEY is set", async () => {
    process.env.GOOGLE_API_KEY = "google-auto";
    const client = await createEmbeddingClient({
      provider: "auto",
      maxRetries: 1,
    });
    expect(client).toBeInstanceOf(GoogleEmbeddingClient);
    expect(client!.dimensions).toBe(768);
  });

  it("returns null for openai provider without api key", async () => {
    const client = await createEmbeddingClient({
      provider: "openai",
      maxRetries: 1,
    });
    expect(client).toBeNull();
  });
});
