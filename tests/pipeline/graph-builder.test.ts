import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../../src/store/schema.js";
import { Store } from "../../src/store/queries.js";
import { build, generateRelationId } from "../../src/pipeline/graph-builder.js";
import {
  EntityType,
  RelationType,
  type Entity,
  type Relation,
  type TextUnit,
  type CommitData,
} from "../../src/shared/types.js";

function createTestStore(): { db: Database.Database; store: Store } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return { db, store: new Store(db) };
}

const alice: Entity = {
  id: "person:alice-chen",
  type: EntityType.PERSON,
  name: "Alice Chen",
  aliases: [],
  description: "Developer",
  firstSeen: "",
  lastSeen: "",
  frequency: 0,
  metadata: {},
};

const billing: Entity = {
  id: "module:src/billing",
  type: EntityType.MODULE,
  name: "src/billing",
  aliases: [],
  description: "Billing module",
  firstSeen: "",
  lastSeen: "",
  frequency: 0,
  metadata: {},
};

const payments: Entity = {
  id: "module:src/payments",
  type: EntityType.MODULE,
  name: "src/payments",
  aliases: [],
  description: "Payments module",
  firstSeen: "",
  lastSeen: "",
  frequency: 0,
  metadata: {},
};

const authoredRelation: Relation = {
  id: "rel:test-001",
  type: RelationType.AUTHORED,
  sourceId: "person:alice-chen",
  targetId: "module:src/billing",
  weight: 8,
  description: "Alice authored billing",
  evidence: ["tu:001"],
  firstSeen: "2024-03-01",
  lastSeen: "2024-03-05",
};

const textUnit: TextUnit = {
  id: "tu:001",
  content: "Alice modified billing module",
  commitHashes: ["abc123"],
  dateRange: { start: "2024-03-01", end: "2024-03-05" },
  entityIds: ["person:alice-chen", "module:src/billing"],
  relationIds: ["rel:test-001"],
};

const commit: CommitData = {
  hash: "abc123",
  authorName: "Alice Chen",
  authorEmail: "alice@acme.com",
  date: "2024-03-01T10:00:00Z",
  message: "feat: update billing",
  filesChanged: [
    {
      path: "src/billing/processor.ts",
      status: "modified",
      additions: 10,
      deletions: 5,
    },
    {
      path: "src/payments/handler.ts",
      status: "modified",
      additions: 3,
      deletions: 1,
    },
  ],
  parentHashes: [],
};

describe("graph-builder", () => {
  let db: Database.Database;
  let store: Store;

  beforeEach(() => {
    ({ db, store } = createTestStore());
  });
  afterEach(() => db.close());

  it("upserts entities with dates from text units", () => {
    const stats = build(store, {
      textUnits: [textUnit],
      entities: [alice, billing],
      relations: [],
      extractions: new Map([
        [
          "tu:001",
          {
            entities: [
              { name: "Alice Chen", type: EntityType.PERSON, description: "dev" },
              { name: "src/billing", type: EntityType.MODULE, description: "billing" },
            ],
            relations: [],
          },
        ],
      ]),
      commits: [],
    });

    expect(stats.entityCount).toBe(2);

    const aliceEntity = store.getEntity("person:alice-chen")!;
    expect(aliceEntity.firstSeen).toBe("2024-03-01");
    expect(aliceEntity.lastSeen).toBe("2024-03-05");
    expect(aliceEntity.frequency).toBe(1);
  });

  it("upserts relations", () => {
    // Need entities first for foreign keys
    store.upsertEntity({ ...alice, firstSeen: "2024-01-01", lastSeen: "2024-01-01", frequency: 1 });
    store.upsertEntity({ ...billing, firstSeen: "2024-01-01", lastSeen: "2024-01-01", frequency: 1 });

    const stats = build(store, {
      textUnits: [],
      entities: [],
      relations: [authoredRelation],
      extractions: new Map(),
      commits: [],
    });

    expect(stats.relationCount).toBe(1);
    const rel = store.getRelation("rel:test-001")!;
    expect(rel.type).toBe(RelationType.AUTHORED);
    expect(rel.weight).toBe(8);
  });

  it("inserts text units and commits", () => {
    const stats = build(store, {
      textUnits: [textUnit],
      entities: [alice, billing],
      relations: [],
      extractions: new Map([
        [
          "tu:001",
          {
            entities: [
              { name: "Alice Chen", type: EntityType.PERSON, description: "" },
              { name: "src/billing", type: EntityType.MODULE, description: "" },
            ],
            relations: [],
          },
        ],
      ]),
      commits: [commit],
    });

    expect(stats.textUnitCount).toBe(1);
    expect(store.getCommitCount()).toBe(1);
  });

  it("creates co-change edges between modules", () => {
    // First insert the module entities so co-change edges can reference them
    store.upsertEntity({ ...billing, firstSeen: "2024-01-01", lastSeen: "2024-01-01", frequency: 1 });
    store.upsertEntity({ ...payments, firstSeen: "2024-01-01", lastSeen: "2024-01-01", frequency: 1 });

    build(store, {
      textUnits: [],
      entities: [],
      relations: [],
      extractions: new Map(),
      commits: [commit], // commit touches billing + payments
    });

    // Should have a CO_CHANGED relation
    const allRelations = store.getAllRelations();
    const coChanged = allRelations.filter(
      (r) => r.type === RelationType.CO_CHANGED,
    );
    expect(coChanged).toHaveLength(1);
  });

  it("returns correct edge density", () => {
    store.upsertEntity({ ...alice, firstSeen: "2024-01-01", lastSeen: "2024-01-01", frequency: 1 });
    store.upsertEntity({ ...billing, firstSeen: "2024-01-01", lastSeen: "2024-01-01", frequency: 1 });

    const stats = build(store, {
      textUnits: [],
      entities: [],
      relations: [authoredRelation],
      extractions: new Map(),
      commits: [],
    });

    // 2 entities, 1 relation: density = 1 / (2 * 1) = 0.5
    expect(stats.edgeDensity).toBe(0.5);
  });
});

describe("generateRelationId", () => {
  it("generates deterministic IDs", () => {
    const id1 = generateRelationId(RelationType.CO_CHANGED, "a", "b");
    const id2 = generateRelationId(RelationType.CO_CHANGED, "a", "b");
    expect(id1).toBe(id2);
  });

  it("is direction-independent for same type", () => {
    const id1 = generateRelationId(RelationType.CO_CHANGED, "a", "b");
    const id2 = generateRelationId(RelationType.CO_CHANGED, "b", "a");
    expect(id1).toBe(id2);
  });
});
