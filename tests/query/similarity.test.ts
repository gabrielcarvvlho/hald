import { describe, it, expect } from "vitest";
import type { EmbeddingClient } from "../../src/llm/embeddings.js";
import { embeddingToBuffer } from "../../src/llm/embeddings.js";
import {
  rankBySimilarity,
  rankBuffersBySimilarity,
  QueryEmbedder,
} from "../../src/query/similarity.js";

// ── Mock client ────────────────────────────────────────────────────────

function createMockEmbeddingClient(): EmbeddingClient {
  return {
    provider: "openai",
    dimensions: 4,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) =>
        t.toLowerCase().includes("payment")
          ? new Float32Array([1, 0, 0, 0])
          : new Float32Array([0, 1, 0, 0]),
      );
    },
  };
}

// ── rankBySimilarity ───────────────────────────────────────────────────

describe("rankBySimilarity", () => {
  it("ranks items correctly (identical > partial > orthogonal)", () => {
    // Query: [1, 0, 0, 0]
    const query = new Float32Array([1, 0, 0, 0]);

    const items = [
      { id: "orthogonal", embedding: new Float32Array([0, 1, 0, 0]) },
      { id: "identical", embedding: new Float32Array([1, 0, 0, 0]) },
      { id: "partial", embedding: new Float32Array([1, 1, 0, 0]) },
    ];

    const results = rankBySimilarity(query, items);

    expect(results[0]!.id).toBe("identical");
    expect(results[1]!.id).toBe("partial");
    expect(results[2]!.id).toBe("orthogonal");
  });

  it("returns correct similarity values", () => {
    const query = new Float32Array([1, 0, 0, 0]);

    const items = [
      { id: "identical", embedding: new Float32Array([1, 0, 0, 0]) },
      { id: "orthogonal", embedding: new Float32Array([0, 1, 0, 0]) },
    ];

    const results = rankBySimilarity(query, items);

    const identical = results.find((r) => r.id === "identical")!;
    const orthogonal = results.find((r) => r.id === "orthogonal")!;

    expect(identical.similarity).toBeCloseTo(1.0);
    expect(orthogonal.similarity).toBeCloseTo(0.0);
  });

  it("returns an empty array when items is empty", () => {
    const query = new Float32Array([1, 0, 0, 0]);
    expect(rankBySimilarity(query, [])).toEqual([]);
  });
});

// ── rankBuffersBySimilarity ────────────────────────────────────────────

describe("rankBuffersBySimilarity", () => {
  it("produces the same ranking as rankBySimilarity", () => {
    const query = new Float32Array([1, 0, 0, 0]);

    const floatItems = [
      { id: "a", embedding: new Float32Array([1, 0, 0, 0]) },
      { id: "b", embedding: new Float32Array([0, 1, 0, 0]) },
    ];

    const bufferItems = floatItems.map((item) => ({
      id: item.id,
      embedding: embeddingToBuffer(item.embedding),
    }));

    const floatResults = rankBySimilarity(query, floatItems);
    const bufferResults = rankBuffersBySimilarity(query, bufferItems);

    expect(bufferResults.map((r) => r.id)).toEqual(floatResults.map((r) => r.id));
    for (let i = 0; i < floatResults.length; i++) {
      expect(bufferResults[i]!.similarity).toBeCloseTo(floatResults[i]!.similarity);
    }
  });
});

// ── QueryEmbedder ──────────────────────────────────────────────────────

describe("QueryEmbedder", () => {
  it("returns null when client is null", async () => {
    const embedder = new QueryEmbedder(null);
    const result = await embedder.embedQuery("payment service");
    expect(result).toBeNull();
  });

  it("caches query embeddings (same reference returned)", async () => {
    const embedder = new QueryEmbedder(createMockEmbeddingClient());
    const first = await embedder.embedQuery("payment service");
    const second = await embedder.embedQuery("payment service");
    expect(first).not.toBeNull();
    expect(first).toBe(second); // same reference
  });

  it("returns different embeddings for different queries", async () => {
    const embedder = new QueryEmbedder(createMockEmbeddingClient());
    const payment = await embedder.embedQuery("payment service");
    const other = await embedder.embedQuery("auth module");
    expect(payment).not.toBeNull();
    expect(other).not.toBeNull();
    // payment maps to [1,0,0,0], other maps to [0,1,0,0]
    expect(Array.from(payment!)).toEqual([1, 0, 0, 0]);
    expect(Array.from(other!)).toEqual([0, 1, 0, 0]);
  });

  it("isAvailable is false when client is null", () => {
    const embedder = new QueryEmbedder(null);
    expect(embedder.isAvailable).toBe(false);
  });

  it("isAvailable is true when client is provided", () => {
    const embedder = new QueryEmbedder(createMockEmbeddingClient());
    expect(embedder.isAvailable).toBe(true);
  });
});
