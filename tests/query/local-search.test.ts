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

  beforeEach(() => {
    ({ db, store } = createPopulatedStore());
  });
  afterEach(() => db.close());

  // ================================================================
  // Core behavior (existing tests, updated for new result shape)
  // ================================================================

  it("finds entities matching a query", () => {
    const result = localSearch(store, { query: "payments" });

    expect(result.entities.length).toBeGreaterThan(0);
    const names = result.entities.map((e) => e.name);
    expect(names).toContain("src/payments");
  });

  it("includes relations for matched entities", () => {
    const result = localSearch(store, { query: "payments" });

    expect(result.relations.length).toBeGreaterThan(0);
  });

  it("includes text units as supporting evidence", () => {
    const result = localSearch(store, { query: "payments gRPC" });

    expect(result.textUnits.length).toBeGreaterThan(0);
    // Text unit about gRPC migration should be included
    const hasGrpcContent = result.textUnits.some((tu) => tu.content.toLowerCase().includes("grpc"));
    expect(hasGrpcContent).toBe(true);
  });

  it("includes community context", () => {
    const result = localSearch(store, { query: "payments" });

    expect(result.communities.length).toBeGreaterThan(0);
    const titles = result.communities.map((c) => c.title);
    expect(titles.some((t) => t.toLowerCase().includes("payment"))).toBe(true);
  });

  it("expands 1-hop via relations", () => {
    // Search for "Alice" → should also find modules she authored
    const result = localSearch(store, { query: "Alice" });

    const names = result.entities.map((e) => e.name);
    expect(names).toContain("Alice Chen");
    // 1-hop expansion should include modules Alice is connected to
    expect(names.some((n) => n.includes("payments") || n.includes("middleware"))).toBe(true);
  });

  it("filters by entity type", () => {
    const result = localSearch(store, {
      query: "payments",
      entityTypes: [EntityType.MODULE],
    });

    // Seed entities should only be MODULE type
    expect(result.entities.length).toBeGreaterThan(0);
    const moduleEntities = result.entities.filter((e) => e.type === EntityType.MODULE);
    expect(moduleEntities.length).toBeGreaterThan(0);
    expect(moduleEntities[0]!.name).toBe("src/payments");
  });

  it("respects maxEntities limit", () => {
    const result = localSearch(store, {
      query: "payments billing",
      maxEntities: 2,
    });

    expect(result.entities.length).toBeLessThanOrEqual(2);
  });

  it("returns empty for no matches", () => {
    const result = localSearch(store, { query: "zzz-nonexistent-xyz" });

    expect(result.entities).toHaveLength(0);
    expect(result.relations).toHaveLength(0);
    expect(result.textUnits).toHaveLength(0);
    expect(result.communities).toHaveLength(0);
  });

  // ================================================================
  // Result structure (ScoredEntity, AnnotatedRelation, metadata)
  // ================================================================

  describe("result structure", () => {
    it("includes query in result", () => {
      const result = localSearch(store, { query: "payments" });
      expect(result.query).toBe("payments");
    });

    it("marks seed entities with isSeed=true and hopDistance=0", () => {
      const result = localSearch(store, { query: "Alice" });

      const alice = result.entities.find((e) => e.name === "Alice Chen");
      expect(alice).toBeDefined();
      expect(alice!.isSeed).toBe(true);
      expect(alice!.hopDistance).toBe(0);
      expect(alice!.score).toBeGreaterThan(0);
      expect(alice!.degree).toBeGreaterThan(0);
    });

    it("marks hop-expanded entities with isSeed=false, hopDistance>0, and real scores", () => {
      const result = localSearch(store, { query: "Alice" });

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

    it("annotates relations with sourceName and targetName", () => {
      const result = localSearch(store, { query: "payments" });

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

    it("reports totalEntityMatches reflecting pre-truncation count", () => {
      // With maxEntities=2, there should be more total matches than returned
      const result = localSearch(store, {
        query: "payments",
        maxEntities: 2,
      });

      expect(result.totalEntityMatches).toBeGreaterThanOrEqual(
        result.entities.filter((e) => e.isSeed).length,
      );
    });

    it("seeds come before neighbors in entity list", () => {
      const result = localSearch(store, { query: "Alice" });

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
    it("produces scores in a reasonable range [0, 1]", () => {
      const result = localSearch(store, { query: "payments" });

      for (const e of result.entities.filter((e) => e.isSeed)) {
        expect(e.score).toBeGreaterThanOrEqual(0);
        expect(e.score).toBeLessThanOrEqual(1);
      }
    });

    it("respects custom ranking weights", () => {
      // Maximize recency weight: recently-seen entities should dominate
      const recencyHeavy = localSearch(store, {
        query: "payments",
        rankingWeights: { fts: 0.1, recency: 0.8, degree: 0.1 },
      });

      // Maximize FTS weight: best text matches should dominate
      const ftsHeavy = localSearch(store, {
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

    it("seeds are sorted by score descending", () => {
      const result = localSearch(store, { query: "payments" });

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
    it("reaches 2-hop neighbors", () => {
      // Alice → src/payments (1-hop) → src/billing (2-hop via DEPENDS_ON/CO_CHANGED)
      const result = localSearch(store, { query: "Alice" });

      const names = result.entities.map((e) => e.name);
      // billing depends on payments, which Alice authored — should reach via 2-hop
      expect(names).toContain("src/billing");

      const billing = result.entities.find((e) => e.name === "src/billing");
      if (billing) {
        expect(billing.hopDistance).toBe(2);
      }
    });

    it("2-hop neighbors score lower than 1-hop neighbors", () => {
      const result = localSearch(store, { query: "Alice" });

      const hop1 = result.entities.filter((e) => e.hopDistance === 1);
      const hop2 = result.entities.filter((e) => e.hopDistance === 2);

      if (hop1.length > 0 && hop2.length > 0) {
        const maxHop1Score = Math.max(...hop1.map((e) => e.score));
        const maxHop2Score = Math.max(...hop2.map((e) => e.score));
        // 2-hop max score (0.25 decay) should be ≤ 1-hop max score (0.5 decay)
        expect(maxHop2Score).toBeLessThanOrEqual(maxHop1Score);
      }
    });

    it("respects maxRelations as upper bound", () => {
      const result = localSearch(store, {
        query: "payments",
        maxRelations: 3,
      });

      expect(result.relations.length).toBeLessThanOrEqual(3);
    });

    it("filters low-weight relations", () => {
      const result = localSearch(store, { query: "payments" });

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
    it("distributes text units across seed entities (round-robin)", () => {
      // "payments" matches src/payments AND the decision entity
      // Round-robin should pick text units from multiple seeds
      const result = localSearch(store, {
        query: "payments gRPC migration",
        maxTextUnits: 3,
      });

      expect(result.textUnits.length).toBeGreaterThan(0);
      // Should have text units from different date ranges (different sources)
      const uniqueIds = new Set(result.textUnits.map((tu) => tu.id));
      expect(uniqueIds.size).toBe(result.textUnits.length); // no duplicates
    });

    it("respects maxTextUnits limit", () => {
      const result = localSearch(store, {
        query: "payments",
        maxTextUnits: 1,
      });

      expect(result.textUnits.length).toBeLessThanOrEqual(1);
    });

    it("respects token budget", () => {
      // With very small token budget, should return fewer text units
      const small = localSearch(store, {
        query: "payments",
        maxTextUnitTokens: 10, // ~40 characters — barely one short text unit
      });
      const large = localSearch(store, {
        query: "payments",
        maxTextUnitTokens: 10000,
      });

      expect(small.textUnits.length).toBeLessThanOrEqual(large.textUnits.length);
    });

    it("prefers recent text units", () => {
      const result = localSearch(store, { query: "payments" });

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
    it("handles camelCase queries via splitting", () => {
      // "PaymentGateway" should find entities even if stored as separate words
      // In our fixture, "src/payments" description has "Payments service"
      // The camelCase split produces "Payment" + "Gateway" — "Payment" should match
      const result = localSearch(store, { query: "PaymentService" });

      // "Payment" token should match entities with "payment" in name/description
      const names = result.entities.map((e) => e.name);
      expect(names.some((n) => n.includes("payment"))).toBe(true);
    });

    it("preserves original token alongside camelCase splits", () => {
      // "gRPC" → camelCase splits to ["g", "RPC"] but original "gRPC" is kept
      // "gRPC" as prefix (grpc*) should match the gRPC technology entity
      const result = localSearch(store, { query: "gRPC" });

      const names = result.entities.map((e) => e.name);
      expect(names.some((n) => n.toLowerCase().includes("grpc"))).toBe(true);
    });

    it("uses prefix matching for short tokens", () => {
      // "auth" (4 chars) should become "auth*" and match "Auth middleware"
      const result = localSearch(store, { query: "auth" });

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
    it("handles maxEntities=1 correctly", () => {
      const result = localSearch(store, {
        query: "payments",
        maxEntities: 1,
      });

      expect(result.entities.length).toBe(1);
      expect(result.entities[0]!.isSeed).toBe(true);
    });

    it("handles query with only stop words gracefully", () => {
      const result = localSearch(store, { query: "who is the" });

      expect(result.entities).toHaveLength(0);
      expect(result.relations).toHaveLength(0);
    });

    it("handles single-character query gracefully", () => {
      const result = localSearch(store, { query: "x" });

      // Single char is filtered out, should return empty
      expect(result.entities).toHaveLength(0);
    });

    it("returns empty result shape with all metadata fields", () => {
      const result = localSearch(store, { query: "zzz-nonexistent" });

      expect(result.query).toBe("zzz-nonexistent");
      expect(result.entities).toHaveLength(0);
      expect(result.relations).toHaveLength(0);
      expect(result.textUnits).toHaveLength(0);
      expect(result.communities).toHaveLength(0);
      expect(result.totalEntityMatches).toBe(0);
      expect(result.totalRelations).toBe(0);
    });

    it("handles entity type filter that matches nothing", () => {
      const result = localSearch(store, {
        query: "payments",
        entityTypes: [EntityType.PATTERN], // no PATTERN entities in fixture
      });

      expect(result.entities).toHaveLength(0);
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

  it("caps relations per seed at MAX_RELATIONS_PER_SEED", () => {
    const result = localSearch(store, {
      query: "hub",
      maxRelations: 50, // generous budget
    });

    // Hub has 30 relations but MAX_RELATIONS_PER_SEED=15 caps it
    // Plus HOP1_BUDGET=15 also caps. So at most 15 relations.
    expect(result.relations.length).toBeLessThanOrEqual(15);
  });

  it("selects highest-weight relations when budget is limited", () => {
    const result = localSearch(store, {
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

  it("does not exceed maxEntities even with many neighbors", () => {
    const result = localSearch(store, {
      query: "hub",
      maxEntities: 5,
    });

    expect(result.entities.length).toBeLessThanOrEqual(5);
  });
});
