import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/store/db.js";
import { Store } from "../../src/store/queries.js";
import {
  EntityType,
  RelationType,
  type Entity,
  type Relation,
  type TextUnit,
  type Community,
  type CommitData,
} from "../../src/shared/types.js";

function createTestStore(): { db: Database.Database; store: Store } {
  const db = openDatabase(":memory:");
  return { db, store: new Store(db) };
}

const sampleEntity: Entity = {
  id: "person:alice",
  type: EntityType.PERSON,
  name: "Alice Chen",
  aliases: ["alice", "achen"],
  description: "Lead developer",
  firstSeen: "2024-01-01",
  lastSeen: "2024-06-15",
  frequency: 5,
  metadata: { email: "alice@acme.com" },
};

const sampleEntity2: Entity = {
  id: "module:src/billing",
  type: EntityType.MODULE,
  name: "src/billing",
  aliases: ["billing"],
  description: "Billing processor module",
  firstSeen: "2024-02-01",
  lastSeen: "2024-06-10",
  frequency: 3,
  metadata: {},
};

describe("Store — Entities", () => {
  let store: Store;
  let db: Database.Database;

  beforeEach(() => {
    ({ db, store } = createTestStore());
  });
  afterEach(() => db.close());

  it("upserts and retrieves an entity", () => {
    store.upsertEntity(sampleEntity);
    const result = store.getEntity("person:alice");

    expect(result).not.toBeNull();
    expect(result!.name).toBe("Alice Chen");
    expect(result!.type).toBe(EntityType.PERSON);
    expect(result!.aliases).toEqual(["alice", "achen"]);
    expect(result!.metadata).toEqual({ email: "alice@acme.com" });
  });

  it("returns null for non-existent entity", () => {
    expect(store.getEntity("nonexistent")).toBeNull();
  });

  it("upsert merges frequency and date range", () => {
    store.upsertEntity(sampleEntity);
    store.upsertEntity({
      ...sampleEntity,
      firstSeen: "2023-12-01", // earlier
      lastSeen: "2024-07-01", // later
      frequency: 3,
    });

    const result = store.getEntity("person:alice")!;
    expect(result.frequency).toBe(8); // 5 + 3
    expect(result.firstSeen).toBe("2023-12-01"); // MIN
    expect(result.lastSeen).toBe("2024-07-01"); // MAX
  });

  it("filters entities by type", () => {
    store.upsertEntity(sampleEntity);
    store.upsertEntity(sampleEntity2);

    const persons = store.getEntitiesByType(EntityType.PERSON);
    expect(persons).toHaveLength(1);
    expect(persons[0]!.id).toBe("person:alice");

    const modules = store.getEntitiesByType(EntityType.MODULE);
    expect(modules).toHaveLength(1);
    expect(modules[0]!.id).toBe("module:src/billing");
  });

  it("getAllEntities returns all entities", () => {
    store.upsertEntity(sampleEntity);
    store.upsertEntity(sampleEntity2);

    expect(store.getAllEntities()).toHaveLength(2);
  });

  it("FTS search finds entities by name", () => {
    store.upsertEntity(sampleEntity);
    store.upsertEntity(sampleEntity2);

    const results = store.searchEntities("Alice");
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("person:alice");
  });

  it("FTS search finds entities by description", () => {
    store.upsertEntity(sampleEntity2);

    const results = store.searchEntities("Billing processor");
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("module:src/billing");
  });

  it("FTS search strips stop words from conversational queries", () => {
    store.upsertEntity(sampleEntity);
    store.upsertEntity(sampleEntity2);

    // "who is the lead developer" → after stop words: "lead developer"
    const results = store.searchEntities("who is the Lead developer");
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("person:alice");
  });

  it("FTS search returns empty for all-stop-word queries", () => {
    store.upsertEntity(sampleEntity);

    const results = store.searchEntities("who is the");
    expect(results).toHaveLength(0);
  });
});

describe("Store — Relations", () => {
  let store: Store;
  let db: Database.Database;

  beforeEach(() => {
    ({ db, store } = createTestStore());
    // Relations need entities due to foreign keys
    store.upsertEntity(sampleEntity);
    store.upsertEntity(sampleEntity2);
  });
  afterEach(() => db.close());

  const sampleRelation: Relation = {
    id: "rel:001",
    type: RelationType.AUTHORED,
    sourceId: "person:alice",
    targetId: "module:src/billing",
    weight: 8,
    description: "Alice authored billing module",
    evidence: ["tu:001", "tu:002"],
    firstSeen: "2024-01-15",
    lastSeen: "2024-06-10",
  };

  it("upserts and retrieves a relation", () => {
    store.upsertRelation(sampleRelation);
    const result = store.getRelation("rel:001");

    expect(result).not.toBeNull();
    expect(result!.type).toBe(RelationType.AUTHORED);
    expect(result!.sourceId).toBe("person:alice");
    expect(result!.targetId).toBe("module:src/billing");
    expect(result!.weight).toBe(8);
    expect(result!.evidence).toEqual(["tu:001", "tu:002"]);
  });

  it("upsert accumulates weight", () => {
    store.upsertRelation(sampleRelation);
    store.upsertRelation({ ...sampleRelation, weight: 3 });

    const result = store.getRelation("rel:001")!;
    expect(result.weight).toBe(11); // 8 + 3
  });

  it("getRelationsBySource returns correct relations", () => {
    store.upsertRelation(sampleRelation);
    const results = store.getRelationsBySource("person:alice");
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("rel:001");
  });

  it("getRelationsByTarget returns correct relations", () => {
    store.upsertRelation(sampleRelation);
    const results = store.getRelationsByTarget("module:src/billing");
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("rel:001");
  });
});

describe("Store — Text Units", () => {
  let store: Store;
  let db: Database.Database;

  beforeEach(() => {
    ({ db, store } = createTestStore());
  });
  afterEach(() => db.close());

  const sampleTextUnit: TextUnit = {
    id: "tu:abc123",
    content: "Alice migrated the payments service from REST to gRPC",
    commitHashes: ["a1b2c3d", "d4e5f6a"],
    dateRange: { start: "2024-03-01", end: "2024-03-05" },
    entityIds: ["person:alice"],
    relationIds: ["rel:001"],
  };

  it("inserts and retrieves a text unit", () => {
    store.insertTextUnit(sampleTextUnit);
    const result = store.getTextUnit("tu:abc123");

    expect(result).not.toBeNull();
    expect(result!.content).toContain("payments service");
    expect(result!.commitHashes).toEqual(["a1b2c3d", "d4e5f6a"]);
    expect(result!.dateRange.start).toBe("2024-03-01");
  });

  it("INSERT OR IGNORE skips duplicates", () => {
    store.insertTextUnit(sampleTextUnit);
    store.insertTextUnit({ ...sampleTextUnit, content: "modified" });

    const result = store.getTextUnit("tu:abc123")!;
    expect(result.content).toContain("payments service"); // original
  });

  it("FTS search finds text units by content", () => {
    store.insertTextUnit(sampleTextUnit);

    const results = store.searchTextUnits("gRPC");
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("tu:abc123");
  });
});

describe("Store — Communities", () => {
  let store: Store;
  let db: Database.Database;

  beforeEach(() => {
    ({ db, store } = createTestStore());
  });
  afterEach(() => db.close());

  const sampleCommunity: Community = {
    id: "comm:0:1",
    level: 0,
    title: "Payments & gRPC Migration",
    summary: "This community covers the payments module migration.",
    entityIds: ["person:alice", "module:src/payments"],
    childIds: [],
  };

  it("upserts and retrieves a community", () => {
    store.upsertCommunity(sampleCommunity);
    const result = store.getCommunity("comm:0:1");

    expect(result).not.toBeNull();
    expect(result!.title).toBe("Payments & gRPC Migration");
    expect(result!.level).toBe(0);
    expect(result!.entityIds).toEqual(["person:alice", "module:src/payments"]);
    expect(result!.parentId).toBeUndefined();
  });

  it("filters communities by level", () => {
    store.upsertCommunity(sampleCommunity);
    store.upsertCommunity({
      ...sampleCommunity,
      id: "comm:1:0",
      level: 1,
      title: "Level 1 community",
    });

    expect(store.getCommunitiesByLevel(0)).toHaveLength(1);
    expect(store.getCommunitiesByLevel(1)).toHaveLength(1);
    expect(store.getCommunitiesByLevel(2)).toHaveLength(0);
  });

  it("FTS search finds communities by title/summary", () => {
    store.upsertCommunity(sampleCommunity);

    const results = store.searchCommunities("payments migration");
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("comm:0:1");
  });

  it("clearCommunities removes all communities", () => {
    store.upsertCommunity(sampleCommunity);
    expect(store.getStats().communities).toBe(1);

    store.clearCommunities();
    expect(store.getStats().communities).toBe(0);
  });
});

describe("Store — Commits", () => {
  let store: Store;
  let db: Database.Database;

  beforeEach(() => {
    ({ db, store } = createTestStore());
  });
  afterEach(() => db.close());

  const sampleCommit: CommitData = {
    hash: "a1b2c3d4e5f6",
    authorName: "Alice Chen",
    authorEmail: "alice@acme.com",
    date: "2024-03-01T10:00:00Z",
    message: "feat: migrate payments to gRPC",
    filesChanged: [
      {
        path: "src/payments/handler.ts",
        status: "modified" as const,
        additions: 45,
        deletions: 12,
      },
    ],
    parentHashes: ["000000"],
  };

  it("inserts and retrieves a commit", () => {
    store.insertCommit(sampleCommit, "tu:001");
    const result = store.getCommit("a1b2c3d4e5f6");

    expect(result).not.toBeNull();
    expect(result!.authorName).toBe("Alice Chen");
    expect(result!.message).toBe("feat: migrate payments to gRPC");
    expect(result!.filesChanged).toHaveLength(1);
    expect(result!.filesChanged[0]!.path).toBe("src/payments/handler.ts");
  });

  it("getCommitCount returns correct count", () => {
    expect(store.getCommitCount()).toBe(0);
    store.insertCommit(sampleCommit, null);
    expect(store.getCommitCount()).toBe(1);
  });
});

describe("Store — Meta", () => {
  let store: Store;
  let db: Database.Database;

  beforeEach(() => {
    ({ db, store } = createTestStore());
  });
  afterEach(() => db.close());

  it("sets and gets metadata", () => {
    store.setMeta("last_indexed_commit", "abc123");
    expect(store.getMeta("last_indexed_commit")).toBe("abc123");
  });

  it("overwrites existing metadata", () => {
    store.setMeta("key", "value1");
    store.setMeta("key", "value2");
    expect(store.getMeta("key")).toBe("value2");
  });

  it("returns null for missing key", () => {
    expect(store.getMeta("nonexistent")).toBeNull();
  });
});

describe("Store — Stats", () => {
  let store: Store;
  let db: Database.Database;

  beforeEach(() => {
    ({ db, store } = createTestStore());
  });
  afterEach(() => db.close());

  it("returns zero counts for empty store", () => {
    const stats = store.getStats();
    expect(stats.entities).toBe(0);
    expect(stats.relations).toBe(0);
    expect(stats.textUnits).toBe(0);
    expect(stats.communities).toBe(0);
    expect(stats.commits).toBe(0);
  });

  it("returns correct counts after inserts", () => {
    store.upsertEntity(sampleEntity);
    store.upsertEntity(sampleEntity2);

    const stats = store.getStats();
    expect(stats.entities).toBe(2);
  });
});

describe("Store — Junction Tables", () => {
  let store: Store;
  let db: Database.Database;

  beforeEach(() => {
    ({ db, store } = createTestStore());
    store.upsertEntity(sampleEntity); // person:alice
    store.upsertEntity(sampleEntity2); // module:src/billing
  });
  afterEach(() => db.close());

  it("insertTextUnit populates text_unit_entities junction table", () => {
    const tu: TextUnit = {
      id: "tu:test-001",
      content: "Test content",
      commitHashes: ["abc123"],
      dateRange: { start: "2024-01-01", end: "2024-01-05" },
      entityIds: ["person:alice", "module:src/billing"],
      relationIds: [],
    };

    store.insertTextUnit(tu);

    const rows = db
      .prepare("SELECT entity_id FROM text_unit_entities WHERE text_unit_id = ? ORDER BY entity_id")
      .all("tu:test-001") as { entity_id: string }[];

    expect(rows).toHaveLength(2);
    expect(rows[0]!.entity_id).toBe("module:src/billing");
    expect(rows[1]!.entity_id).toBe("person:alice");
  });

  it("upsertCommunity populates community_entities junction table", () => {
    const community: Community = {
      id: "comm:0:test",
      level: 0,
      title: "Test Community",
      summary: "A test community",
      entityIds: ["person:alice", "module:src/billing"],
      childIds: [],
    };

    store.upsertCommunity(community);

    const rows = db
      .prepare("SELECT entity_id FROM community_entities WHERE community_id = ? ORDER BY entity_id")
      .all("comm:0:test") as { entity_id: string }[];

    expect(rows).toHaveLength(2);
    expect(rows[0]!.entity_id).toBe("module:src/billing");
    expect(rows[1]!.entity_id).toBe("person:alice");
  });

  it("upsertCommunity replaces junction entries on re-upsert", () => {
    const community: Community = {
      id: "comm:0:test",
      level: 0,
      title: "Test",
      summary: "",
      entityIds: ["person:alice", "module:src/billing"],
      childIds: [],
    };

    store.upsertCommunity(community);

    store.upsertCommunity({
      ...community,
      entityIds: ["person:alice"],
    });

    const rows = db
      .prepare("SELECT entity_id FROM community_entities WHERE community_id = ?")
      .all("comm:0:test") as { entity_id: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity_id).toBe("person:alice");
  });

  it("clearCommunities cascades to community_entities", () => {
    store.upsertCommunity({
      id: "comm:0:test",
      level: 0,
      title: "Test",
      summary: "",
      entityIds: ["person:alice"],
      childIds: [],
    });

    store.clearCommunities();

    const rows = db.prepare("SELECT * FROM community_entities").all();
    expect(rows).toHaveLength(0);
  });

  it("getTextUnitsForEntity uses junction table", () => {
    store.insertTextUnit({
      id: "tu:001",
      content: "Alice worked on billing",
      commitHashes: ["abc123"],
      dateRange: { start: "2024-01-01", end: "2024-01-05" },
      entityIds: ["person:alice", "module:src/billing"],
      relationIds: [],
    });
    store.insertTextUnit({
      id: "tu:002",
      content: "Unrelated text unit",
      commitHashes: ["def456"],
      dateRange: { start: "2024-02-01", end: "2024-02-05" },
      entityIds: ["module:src/billing"],
      relationIds: [],
    });

    const aliceUnits = store.getTextUnitsForEntity("person:alice");
    expect(aliceUnits).toHaveLength(1);
    expect(aliceUnits[0]!.id).toBe("tu:001");

    const billingUnits = store.getTextUnitsForEntity("module:src/billing");
    expect(billingUnits).toHaveLength(2);
  });

  it("getCommunitiesForEntity uses junction table", () => {
    store.upsertCommunity({
      id: "comm:0:payments",
      level: 0,
      title: "Payments",
      summary: "",
      entityIds: ["person:alice", "module:src/billing"],
      childIds: [],
    });
    store.upsertCommunity({
      id: "comm:0:other",
      level: 0,
      title: "Other",
      summary: "",
      entityIds: ["module:src/billing"],
      childIds: [],
    });

    const aliceComms = store.getCommunitiesForEntity("person:alice");
    expect(aliceComms).toHaveLength(1);
    expect(aliceComms[0]!.id).toBe("comm:0:payments");

    const billingComms = store.getCommunitiesForEntity("module:src/billing");
    expect(billingComms).toHaveLength(2);
  });
});

describe("Store — Batch Entity Lookup", () => {
  let store: Store;
  let db: Database.Database;

  beforeEach(() => {
    ({ db, store } = createTestStore());
    store.upsertEntity(sampleEntity); // person:alice
    store.upsertEntity(sampleEntity2); // module:src/billing
  });
  afterEach(() => db.close());

  it("returns a map of entities by ID", () => {
    const result = store.getEntitiesByIds(["person:alice", "module:src/billing"]);

    expect(result.size).toBe(2);
    expect(result.get("person:alice")!.name).toBe("Alice Chen");
    expect(result.get("module:src/billing")!.name).toBe("src/billing");
  });

  it("skips non-existent IDs without error", () => {
    const result = store.getEntitiesByIds(["person:alice", "nonexistent:id"]);

    expect(result.size).toBe(1);
    expect(result.has("person:alice")).toBe(true);
    expect(result.has("nonexistent:id")).toBe(false);
  });

  it("returns empty map for empty input", () => {
    const result = store.getEntitiesByIds([]);
    expect(result.size).toBe(0);
  });

  it("deduplicates input IDs", () => {
    const result = store.getEntitiesByIds(["person:alice", "person:alice"]);
    expect(result.size).toBe(1);
  });
});

describe("Store — Transactions", () => {
  let store: Store;
  let db: Database.Database;

  beforeEach(() => {
    ({ db, store } = createTestStore());
  });
  afterEach(() => db.close());

  it("wraps multiple operations in a single transaction", () => {
    store.transaction(() => {
      store.upsertEntity(sampleEntity);
      store.upsertEntity(sampleEntity2);
    });

    expect(store.getEntity("person:alice")).not.toBeNull();
    expect(store.getEntity("module:src/billing")).not.toBeNull();
  });

  it("rolls back all operations on error", () => {
    expect(() => {
      store.transaction(() => {
        store.upsertEntity(sampleEntity);
        throw new Error("simulated failure");
      });
    }).toThrow("simulated failure");

    expect(store.getEntity("person:alice")).toBeNull();
  });

  it("returns the value from the wrapped function", () => {
    const result = store.transaction(() => {
      store.upsertEntity(sampleEntity);
      return store.getEntity("person:alice");
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe("Alice Chen");
  });
});
