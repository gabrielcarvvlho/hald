import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Store as StoreType } from "../../src/store/queries.js";
import { Store } from "../../src/store/queries.js";
import { initSchema, runMigrations } from "../../src/store/schema.js";
import { createPopulatedStore } from "../helpers/sample-store.js";
import { localSearch } from "../../src/query/local-search.js";
import type { AnnotatedRelation } from "../../src/query/local-search.js";
import { EntityType, RelationType } from "../../src/shared/types.js";
import type { Entity, Relation } from "../../src/shared/types.js";

describe("localSearch", () => {
  let db: Database.Database;
  let store: StoreType;

  beforeEach(async () => {
    ({ db, store } = await createPopulatedStore());
  });
  afterEach(() => db.close());

  // ================================================================
  // Core behavior (existing tests, updated for new result shape)
  // ================================================================

  it("finds entities matching a query", async () => {
    const result = await localSearch(store, { query: "payments" });

    expect(result.entities.length).toBeGreaterThan(0);
    const names = result.entities.map((e) => e.name);
    expect(names).toContain("src/payments");
  });

  it("includes relations for matched entities", async () => {
    const result = await localSearch(store, { query: "payments" });

    expect(result.relations.length).toBeGreaterThan(0);
  });

  it("includes text units as supporting evidence", async () => {
    const result = await localSearch(store, { query: "payments gRPC" });

    expect(result.textUnits.length).toBeGreaterThan(0);
    // Text unit about gRPC migration should be included
    const hasGrpcContent = result.textUnits.some((tu) => tu.content.toLowerCase().includes("grpc"));
    expect(hasGrpcContent).toBe(true);
  });

  it("includes community context", async () => {
    const result = await localSearch(store, { query: "payments" });

    expect(result.communities.length).toBeGreaterThan(0);
    const titles = result.communities.map((c) => c.title);
    expect(titles.some((t) => t.toLowerCase().includes("payment"))).toBe(true);
  });

  it("expands 1-hop via relations", async () => {
    // Search for "Alice" → should also find modules she authored
    const result = await localSearch(store, { query: "Alice" });

    const names = result.entities.map((e) => e.name);
    expect(names).toContain("Alice Chen");
    // 1-hop expansion should include modules Alice is connected to
    expect(names.some((n) => n.includes("payments") || n.includes("middleware"))).toBe(true);
  });

  it("filters by entity type", async () => {
    const result = await localSearch(store, {
      query: "payments",
      entityTypes: [EntityType.MODULE],
    });

    // Seed entities should only be MODULE type
    expect(result.entities.length).toBeGreaterThan(0);
    const moduleEntities = result.entities.filter((e) => e.type === EntityType.MODULE);
    expect(moduleEntities.length).toBeGreaterThan(0);
    expect(moduleEntities[0]!.name).toBe("src/payments");
  });

  it("respects maxEntities limit", async () => {
    const result = await localSearch(store, {
      query: "payments billing",
      maxEntities: 2,
    });

    expect(result.entities.length).toBeLessThanOrEqual(2);
  });

  it("returns empty for no matches", async () => {
    const result = await localSearch(store, { query: "zzz-nonexistent-xyz" });

    expect(result.entities).toHaveLength(0);
    expect(result.relations).toHaveLength(0);
    expect(result.textUnits).toHaveLength(0);
    expect(result.communities).toHaveLength(0);
  });

  // ================================================================
  // Result structure (ScoredEntity, AnnotatedRelation, metadata)
  // ================================================================

  describe("result structure", () => {
    it("includes query in result", async () => {
      const result = await localSearch(store, { query: "payments" });
      expect(result.query).toBe("payments");
    });

    it("marks seed entities with isSeed=true and hopDistance=0", async () => {
      const result = await localSearch(store, { query: "Alice" });

      const alice = result.entities.find((e) => e.name === "Alice Chen");
      expect(alice).toBeDefined();
      expect(alice!.isSeed).toBe(true);
      expect(alice!.hopDistance).toBe(0);
      expect(alice!.score).toBeGreaterThan(0);
      expect(alice!.degree).toBeGreaterThan(0);
    });

    it("marks hop-expanded entities with isSeed=false, hopDistance>0, and real scores", async () => {
      const result = await localSearch(store, { query: "Alice" });

      const neighbors = result.entities.filter((e) => !e.isSeed);
      expect(neighbors.length).toBeGreaterThan(0);
      for (const n of neighbors) {
        expect(n.hopDistance).toBeGreaterThanOrEqual(1);
        expect(n.isSeed).toBe(false);
        // Neighbors should have real scores based on relation weight, not 0
        expect(n.score).toBeGreaterThan(0);
        // Neighbor scores should be below seed scores (decay by hop distance)
        expect(n.score).toBeLessThanOrEqual(0.5);
      }
    });

    it("annotates relations with sourceName and targetName", async () => {
      const result = await localSearch(store, { query: "payments" });

      expect(result.relations.length).toBeGreaterThan(0);
      for (const rel of result.relations) {
        const annotated = rel as AnnotatedRelation;
        expect(annotated.sourceName).toBeDefined();
        expect(annotated.targetName).toBeDefined();
        // Names should not be raw IDs (they should resolve to human names)
        expect(annotated.sourceName).not.toMatch(/^(person|module|technology|decision):/);
        expect(annotated.targetName).not.toMatch(/^(person|module|technology|decision):/);
      }
    });

    it("reports totalEntityMatches reflecting pre-truncation count", async () => {
      // With maxEntities=2, there should be more total matches than returned
      const result = await localSearch(store, {
        query: "payments",
        maxEntities: 2,
      });

      expect(result.totalEntityMatches).toBeGreaterThanOrEqual(
        result.entities.filter((e) => e.isSeed).length,
      );
    });

    it("seeds come before neighbors in entity list", async () => {
      const result = await localSearch(store, { query: "Alice" });

      let seenNeighbor = false;
      for (const e of result.entities) {
        if (!e.isSeed) seenNeighbor = true;
        if (e.isSeed && seenNeighbor) {
          throw new Error("Seed entity found after neighbor — ordering violated");
        }
      }
    });
  });

  // ================================================================
  // Composite scoring
  // ================================================================

  describe("composite scoring", () => {
    it("produces scores in a reasonable range [0, 1]", async () => {
      const result = await localSearch(store, { query: "payments" });

      for (const e of result.entities.filter((e) => e.isSeed)) {
        expect(e.score).toBeGreaterThanOrEqual(0);
        expect(e.score).toBeLessThanOrEqual(1);
      }
    });

    it("respects custom ranking weights", async () => {
      // Maximize recency weight: recently-seen entities should dominate
      const recencyHeavy = await localSearch(store, {
        query: "payments",
        rankingWeights: { fts: 0.1, recency: 0.8, degree: 0.1 },
      });

      // Maximize FTS weight: best text matches should dominate
      const ftsHeavy = await localSearch(store, {
        query: "payments",
        rankingWeights: { fts: 0.8, recency: 0.1, degree: 0.1 },
      });

      // Both should find entities, but ordering may differ
      expect(recencyHeavy.entities.length).toBeGreaterThan(0);
      expect(ftsHeavy.entities.length).toBeGreaterThan(0);

      // Scores should differ since weights changed
      const recencyScores = recencyHeavy.entities.filter((e) => e.isSeed).map((e) => e.score);
      const ftsScores = ftsHeavy.entities.filter((e) => e.isSeed).map((e) => e.score);
      expect(recencyScores).not.toEqual(ftsScores);
    });

    it("seeds are sorted by score descending", async () => {
      const result = await localSearch(store, { query: "payments" });

      const seeds = result.entities.filter((e) => e.isSeed);
      for (let i = 1; i < seeds.length; i++) {
        expect(seeds[i - 1]!.score).toBeGreaterThanOrEqual(seeds[i]!.score);
      }
    });
  });

  // ================================================================
  // Budget-aware hop expansion
  // ================================================================

  describe("hop expansion", () => {
    it("reaches 2-hop neighbors", async () => {
      // Alice → src/payments (1-hop) → src/billing (2-hop via DEPENDS_ON/CO_CHANGED)
      const result = await localSearch(store, { query: "Alice" });

      const names = result.entities.map((e) => e.name);
      // billing depends on payments, which Alice authored — should reach via 2-hop
      expect(names).toContain("src/billing");

      const billing = result.entities.find((e) => e.name === "src/billing");
      if (billing) {
        expect(billing.hopDistance).toBe(2);
      }
    });

    it("2-hop neighbors score lower than 1-hop neighbors", async () => {
      const result = await localSearch(store, { query: "Alice" });

      const hop1 = result.entities.filter((e) => e.hopDistance === 1);
      const hop2 = result.entities.filter((e) => e.hopDistance === 2);

      if (hop1.length > 0 && hop2.length > 0) {
        const maxHop1Score = Math.max(...hop1.map((e) => e.score));
        const maxHop2Score = Math.max(...hop2.map((e) => e.score));
        // 2-hop max score (0.25 decay) should be ≤ 1-hop max score (0.5 decay)
        expect(maxHop2Score).toBeLessThanOrEqual(maxHop1Score);
      }
    });

    it("respects maxRelations as upper bound", async () => {
      const result = await localSearch(store, {
        query: "payments",
        maxRelations: 3,
      });

      expect(result.relations.length).toBeLessThanOrEqual(3);
    });

    it("filters low-weight relations", async () => {
      const result = await localSearch(store, { query: "payments" });

      // All returned relations should meet minimum weight threshold
      for (const rel of result.relations) {
        expect(rel.weight).toBeGreaterThanOrEqual(1.0);
      }
    });
  });

  // ================================================================
  // Text unit selection
  // ================================================================

  describe("text unit selection", () => {
    it("distributes text units across seed entities (round-robin)", async () => {
      // "payments" matches src/payments AND the decision entity
      // Round-robin should pick text units from multiple seeds
      const result = await localSearch(store, {
        query: "payments gRPC migration",
        maxTextUnits: 3,
      });

      expect(result.textUnits.length).toBeGreaterThan(0);
      // Should have text units from different date ranges (different sources)
      const uniqueIds = new Set(result.textUnits.map((tu) => tu.id));
      expect(uniqueIds.size).toBe(result.textUnits.length); // no duplicates
    });

    it("respects maxTextUnits limit", async () => {
      const result = await localSearch(store, {
        query: "payments",
        maxTextUnits: 1,
      });

      expect(result.textUnits.length).toBeLessThanOrEqual(1);
    });

    it("respects token budget", async () => {
      // With very small token budget, should return fewer text units
      const small = await localSearch(store, {
        query: "payments",
        maxTextUnitTokens: 10, // ~40 characters — barely one short text unit
      });
      const large = await localSearch(store, {
        query: "payments",
        maxTextUnitTokens: 10000,
      });

      expect(small.textUnits.length).toBeLessThanOrEqual(large.textUnits.length);
    });

    it("prefers recent text units", async () => {
      const result = await localSearch(store, { query: "payments" });

      if (result.textUnits.length >= 2) {
        // Text units should be sorted by recency within each entity's selection
        // At minimum, later-dated text units should appear
        const dates = result.textUnits.map((tu) => tu.dateRange.end);
        const hasRecentFirst = dates.some((d) => d >= "2024-03-10");
        expect(hasRecentFirst).toBe(true);
      }
    });
  });

  // ================================================================
  // FTS5 query quality
  // ================================================================

  describe("FTS5 query improvements", () => {
    it("handles camelCase queries via splitting", async () => {
      // "PaymentGateway" should find entities even if stored as separate words
      // In our fixture, "src/payments" description has "Payments service"
      // The camelCase split produces "Payment" + "Gateway" — "Payment" should match
      const result = await localSearch(store, { query: "PaymentService" });

      // "Payment" token should match entities with "payment" in name/description
      const names = result.entities.map((e) => e.name);
      expect(names.some((n) => n.includes("payment"))).toBe(true);
    });

    it("preserves original token alongside camelCase splits", async () => {
      // "gRPC" → camelCase splits to ["g", "RPC"] but original "gRPC" is kept
      // "gRPC" as prefix (grpc*) should match the gRPC technology entity
      const result = await localSearch(store, { query: "gRPC" });

      const names = result.entities.map((e) => e.name);
      expect(names.some((n) => n.toLowerCase().includes("grpc"))).toBe(true);
    });

    it("uses prefix matching for short tokens", async () => {
      // "auth" (4 chars) should become "auth*" and match "Auth middleware"
      const result = await localSearch(store, { query: "auth" });

      // "auth*" should match src/middleware (description: "Auth middleware layer")
      const hasAuthRelated = result.entities.some(
        (e) =>
          e.description.toLowerCase().includes("auth") || e.name.toLowerCase().includes("auth"),
      );
      expect(hasAuthRelated).toBe(true);
    });
  });

  // ================================================================
  // Edge cases
  // ================================================================

  describe("edge cases", () => {
    it("handles maxEntities=1 correctly", async () => {
      const result = await localSearch(store, {
        query: "payments",
        maxEntities: 1,
      });

      expect(result.entities.length).toBe(1);
      expect(result.entities[0]!.isSeed).toBe(true);
    });

    it("handles query with only stop words gracefully", async () => {
      const result = await localSearch(store, { query: "who is the" });

      expect(result.entities).toHaveLength(0);
      expect(result.relations).toHaveLength(0);
    });

    it("handles single-character query gracefully", async () => {
      const result = await localSearch(store, { query: "x" });

      // Single char is filtered out, should return empty
      expect(result.entities).toHaveLength(0);
    });

    it("returns empty result shape with all metadata fields", async () => {
      const result = await localSearch(store, { query: "zzz-nonexistent" });

      expect(result.query).toBe("zzz-nonexistent");
      expect(result.entities).toHaveLength(0);
      expect(result.relations).toHaveLength(0);
      expect(result.textUnits).toHaveLength(0);
      expect(result.communities).toHaveLength(0);
      expect(result.totalEntityMatches).toBe(0);
      expect(result.totalRelations).toBe(0);
    });

    it("handles entity type filter that matches nothing", async () => {
      const result = await localSearch(store, {
        query: "payments",
        entityTypes: [EntityType.PATTERN], // no PATTERN entities in fixture
      });

      expect(result.entities).toHaveLength(0);
    });
  });

  // ================================================================
  // Hybrid search (embedding + FTS)
  // ================================================================

  describe("hybrid search", () => {
    it("uses hybrid scoring when queryEmbedder is provided", async () => {
      const { QueryEmbedder } = await import("../../src/query/similarity.js");
      const mockClient = {
        provider: "openai" as const,
        dimensions: 4,
        async embed(texts: string[]): Promise<Float32Array[]> {
          // Return vector similar to payments entities
          return texts.map(() => new Float32Array([0.85, 0.1, 0.0, 0.05]));
        },
      };
      const embedder = new QueryEmbedder(mockClient);
      const result = await localSearch(store, {
        query: "financial transactions",
        queryEmbedder: embedder,
      });
      // With embeddings, should find payments/billing by semantic similarity
      expect(result.entities.length).toBeGreaterThan(0);
    });

    it("falls back to FTS-only when query embedding dimensions mismatch the index", async () => {
      const { QueryEmbedder } = await import("../../src/query/similarity.js");
      // Index stores 4-dim vectors (embedding_dimensions="4" in the fixture).
      // Simulate querying under a different provider that emits 3-dim vectors.
      const mismatchedClient = {
        provider: "google" as const,
        dimensions: 3,
        async embed(texts: string[]): Promise<Float32Array[]> {
          return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
        },
      };
      const embedder = new QueryEmbedder(mismatchedClient);

      // Must not throw "Dimension mismatch" — should gracefully degrade to FTS.
      const result = await localSearch(store, {
        query: "payments",
        queryEmbedder: embedder,
      });

      // FTS-only fallback still returns matching entities.
      expect(result.entities.length).toBeGreaterThan(0);
      expect(result.entities.map((e) => e.name)).toContain("src/payments");
    });
  });
});

// ================================================================
// Isolated scoring / expansion tests with controlled fixture
// ================================================================

describe("localSearch — hub entity budget control", () => {
  let db: Database.Database;
  let store: StoreType;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    runMigrations(db);
    store = new Store(db);

    // Create a hub MODULE with many relations to test budget capping
    const hub: Entity = {
      id: "module:hub",
      type: EntityType.MODULE,
      name: "src/hub",
      aliases: ["hub"],
      description: "Hub module with many connections",
      firstSeen: "2024-01-01",
      lastSeen: "2024-06-01",
      frequency: 50,
      metadata: {},
    };
    store.upsertEntity(hub);

    // Create 30 person entities and 30 AUTHORED relations to the hub
    for (let i = 0; i < 30; i++) {
      const person: Entity = {
        id: `person:dev-${i}`,
        type: EntityType.PERSON,
        name: `Developer ${i}`,
        aliases: [],
        description: `Developer number ${i}`,
        firstSeen: "2024-01-01",
        lastSeen: "2024-06-01",
        frequency: 1,
        metadata: {},
      };
      store.upsertEntity(person);

      const rel: Relation = {
        id: `rel:dev-${i}-hub`,
        type: RelationType.AUTHORED,
        sourceId: `person:dev-${i}`,
        targetId: "module:hub",
        weight: 2 + i, // weights from 2 to 31
        description: `Developer ${i} authored hub`,
        evidence: [],
        firstSeen: "2024-01-01",
        lastSeen: "2024-06-01",
      };
      store.upsertRelation(rel);
    }
  });

  afterEach(() => db.close());

  it("caps relations per seed at MAX_RELATIONS_PER_SEED", async () => {
    const result = await localSearch(store, {
      query: "hub",
      maxRelations: 50, // generous budget
    });

    // Hub has 30 relations but MAX_RELATIONS_PER_SEED=15 caps it
    // Plus HOP1_BUDGET=15 also caps. So at most 15 relations.
    expect(result.relations.length).toBeLessThanOrEqual(15);
  });

  it("selects highest-weight relations when budget is limited", async () => {
    const result = await localSearch(store, {
      query: "hub",
      maxRelations: 5,
    });

    expect(result.relations.length).toBeLessThanOrEqual(5);

    // Should pick the highest-weight relations (dev-29=31, dev-28=30, ...)
    const weights = result.relations.map((r) => r.weight);
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i - 1]).toBeGreaterThanOrEqual(weights[i]!);
    }
  });

  it("does not exceed maxEntities even with many neighbors", async () => {
    const result = await localSearch(store, {
      query: "hub",
      maxEntities: 5,
    });

    expect(result.entities.length).toBeLessThanOrEqual(5);
  });
});

// ================================================================
// totalRelations accounting — must count ALL candidate relations,
// independent of the hop-1 traversal budget.
// ================================================================

describe("localSearch — totalRelations accounting", () => {
  let db: Database.Database;
  let store: StoreType;

  // Two MODULE seeds that both match the query "widget", each connected to
  // several distinct PERSON neighbors. With a tiny maxRelations the hop-1
  // budget is exhausted while processing the first seed, so the buggy
  // implementation (which incremented totalRelations inside the budget loop,
  // after the `if (budget <= 0) break`) would never count the second seed's
  // relations. The correct count is the full candidate set across both seeds.
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    runMigrations(db);
    store = new Store(db);

    const modules = ["alpha", "beta"];
    for (const m of modules) {
      const mod: Entity = {
        id: `module:widget-${m}`,
        type: EntityType.MODULE,
        name: `src/widget-${m}`,
        aliases: [],
        description: `Widget ${m} module`,
        firstSeen: "2024-01-01",
        lastSeen: "2024-06-01",
        frequency: 5,
        metadata: {},
      };
      store.upsertEntity(mod);

      // 5 authored relations per module → 10 candidate relations total.
      for (let i = 0; i < 5; i++) {
        const person: Entity = {
          id: `person:${m}-dev-${i}`,
          // Names/descriptions deliberately avoid the "widget" token so only the
          // two modules surface as FTS seeds — keeps the candidate count exact.
          type: EntityType.PERSON,
          name: `Contributor ${m.toUpperCase()} ${i}`,
          aliases: [],
          description: `Engineer number ${i} on team ${m}`,
          firstSeen: "2024-01-01",
          lastSeen: "2024-06-01",
          frequency: 1,
          metadata: {},
        };
        store.upsertEntity(person);

        const rel: Relation = {
          id: `rel:${m}-dev-${i}`,
          type: RelationType.AUTHORED,
          sourceId: `person:${m}-dev-${i}`,
          targetId: `module:widget-${m}`,
          weight: 3 + i,
          description: `Dev ${i} authored widget ${m}`,
          evidence: [],
          firstSeen: "2024-01-01",
          lastSeen: "2024-06-01",
        };
        store.upsertRelation(rel);
      }
    }
  });

  afterEach(() => db.close());

  it("reports totalRelations across all seeds even when the hop budget is exhausted early", async () => {
    const result = await localSearch(store, {
      query: "widget",
      maxRelations: 2, // exhausts the hop-1 budget on the first seed
    });

    // Budget caps the traversed/returned relations…
    expect(result.relations.length).toBeLessThanOrEqual(2);

    // …but totalRelations must reflect the full candidate set: both seeds,
    // 5 relations each = 10. The buggy version under-reported (≈5) because the
    // second seed was skipped once the budget hit zero.
    const candidateCount =
      store.getRelationsForEntity("module:widget-alpha").length +
      store.getRelationsForEntity("module:widget-beta").length;
    expect(candidateCount).toBe(10);
    expect(result.totalRelations).toBe(candidateCount);
  });

  it("totalRelations is independent of maxRelations", async () => {
    const tight = await localSearch(store, { query: "widget", maxRelations: 1 });
    const loose = await localSearch(store, { query: "widget", maxRelations: 50 });

    expect(tight.totalRelations).toBe(loose.totalRelations);
    expect(tight.totalRelations).toBe(10);
  });
});
