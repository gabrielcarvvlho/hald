import { describe, it, expect } from "vitest";
import { embedEntitiesAndCommunities } from "../../src/pipeline/embedder.js";
import { bufferToEmbedding } from "../../src/llm/embeddings.js";
import type { EmbeddingClient } from "../../src/llm/embeddings.js";
import { createPopulatedStore } from "../helpers/sample-store.js";

function createMockEmbeddingClient(dimensions: number): EmbeddingClient {
  return {
    provider: "openai",
    dimensions,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((text) => {
        const arr = new Float32Array(dimensions);
        for (let i = 0; i < dimensions; i++) {
          arr[i] = Math.sin(text.charCodeAt(i % text.length) + i) * 0.5;
        }
        return arr;
      });
    },
  };
}

describe("embedder", () => {
  it("embeds all entities and communities", async () => {
    const { store, db } = await createPopulatedStore();
    const client = createMockEmbeddingClient(64);

    const result = await embedEntitiesAndCommunities(store, client);

    // Sample store has 8 entities and 2 communities (both with summaries)
    expect(result.entitiesEmbedded).toBe(8);
    expect(result.communitiesEmbedded).toBe(2);
    expect(result.entitiesSkipped).toBe(0);
    expect(result.communitiesSkipped).toBe(0);

    // Verify a stored embedding has the correct length
    const embBuf = store.getEntityEmbedding("person:alice-chen");
    expect(embBuf).not.toBeNull();
    const vec = bufferToEmbedding(embBuf!);
    expect(vec.length).toBe(64);

    // Verify community embedding stored
    const commBuf = store.getCommunityEmbedding("comm:0:0");
    expect(commBuf).not.toBeNull();
    const commVec = bufferToEmbedding(commBuf!);
    expect(commVec.length).toBe(64);

    // Verify metadata persisted
    expect(store.getMeta("embedding_model")).toBe("openai");
    expect(store.getMeta("embedding_dimensions")).toBe("64");
    expect(store.getMeta("embedding_hashes")).toBeTruthy();

    db.close();
  });

  it("skips entities that already have embeddings with same description", async () => {
    const { store, db } = await createPopulatedStore();
    const client = createMockEmbeddingClient(64);

    // First run — embed everything
    const first = await embedEntitiesAndCommunities(store, client);
    expect(first.entitiesEmbedded).toBe(8);
    expect(first.communitiesEmbedded).toBe(2);

    // Second run — all hashes match, nothing new to embed
    const second = await embedEntitiesAndCommunities(store, client);
    expect(second.entitiesEmbedded).toBe(0);
    expect(second.communitiesEmbedded).toBe(0);
    expect(second.entitiesSkipped).toBe(8);
    expect(second.communitiesSkipped).toBe(2);

    db.close();
  });

  it("returns zero counts when client is null", async () => {
    const { store, db } = await createPopulatedStore();

    const result = await embedEntitiesAndCommunities(store, null);

    expect(result.entitiesEmbedded).toBe(0);
    expect(result.communitiesEmbedded).toBe(0);
    expect(result.entitiesSkipped).toBe(0);
    expect(result.communitiesSkipped).toBe(0);

    // Pre-existing embeddings from sample store remain, but no new ones were added
    const embBuf = store.getEntityEmbedding("person:alice-chen");
    expect(embBuf).not.toBeNull();

    db.close();
  });

  it("re-embeds entity when description changes", async () => {
    const { store, db } = await createPopulatedStore();
    const client = createMockEmbeddingClient(64);

    // First run
    await embedEntitiesAndCommunities(store, client);

    const originalBuf = store.getEntityEmbedding("person:alice-chen")!;
    const originalVec = bufferToEmbedding(originalBuf);

    // Update Alice's description
    store.upsertEntity({
      id: "person:alice-chen",
      type: "PERSON" as any,
      name: "Alice Chen",
      aliases: ["alice"],
      description: "Senior architect now leading the platform team",
      firstSeen: "2024-01-01",
      lastSeen: "2024-06-15",
      frequency: 12,
      metadata: { email: "alice@acme.com" },
    });

    // Second run — Alice should be re-embedded, others skipped
    const result = await embedEntitiesAndCommunities(store, client);
    expect(result.entitiesEmbedded).toBe(1);
    expect(result.entitiesSkipped).toBe(7);

    // Verify new embedding is different
    const newBuf = store.getEntityEmbedding("person:alice-chen")!;
    const newVec = bufferToEmbedding(newBuf);
    expect(newVec.length).toBe(64);

    // Embeddings should differ because the text changed
    let same = true;
    for (let i = 0; i < originalVec.length; i++) {
      if (originalVec[i] !== newVec[i]) {
        same = false;
        break;
      }
    }
    expect(same).toBe(false);

    db.close();
  });
});
