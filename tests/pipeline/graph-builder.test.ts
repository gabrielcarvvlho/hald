import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema, runMigrations } from "../../src/store/schema.js";
import { Store } from "../../src/store/queries.js";
import {
  build,
  buildOwnershipGraph,
  generateRelationId,
} from "../../src/pipeline/graph-builder.js";
import { generateEntityId } from "../../src/pipeline/resolver.js";
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
  runMigrations(db);
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
    store.upsertEntity({
      ...billing,
      firstSeen: "2024-01-01",
      lastSeen: "2024-01-01",
      frequency: 1,
    });

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
    store.upsertEntity({
      ...billing,
      firstSeen: "2024-01-01",
      lastSeen: "2024-01-01",
      frequency: 1,
    });
    store.upsertEntity({
      ...payments,
      firstSeen: "2024-01-01",
      lastSeen: "2024-01-01",
      frequency: 1,
    });

    build(store, {
      textUnits: [],
      entities: [],
      relations: [],
      extractions: new Map(),
      commits: [commit], // commit touches billing + payments
    });

    // Should have a CO_CHANGED relation weighted by min(linesA, linesB)
    const allRelations = store.getAllRelations();
    const coChanged = allRelations.filter((r) => r.type === RelationType.CO_CHANGED);
    expect(coChanged).toHaveLength(1);
    // billing: 10+5=15 lines, payments: 3+1=4 lines → min(15,4) = 4
    expect(coChanged[0]!.weight).toBe(4);
  });

  it("returns correct edge density", () => {
    store.upsertEntity({ ...alice, firstSeen: "2024-01-01", lastSeen: "2024-01-01", frequency: 1 });
    store.upsertEntity({
      ...billing,
      firstSeen: "2024-01-01",
      lastSeen: "2024-01-01",
      frequency: 1,
    });

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

// ================================================================
// Deterministic ownership layer (headline "connections" feature)
// ================================================================

describe("buildOwnershipGraph", () => {
  const addedCommit: CommitData = {
    hash: "c1",
    authorName: "Alice Chen",
    authorEmail: "alice@acme.com",
    date: "2024-01-01T00:00:00Z",
    message: "feat: add billing",
    filesChanged: [
      { path: "src/billing/processor.ts", status: "added", additions: 40, deletions: 0 },
      { path: "src/billing/types.ts", status: "added", additions: 10, deletions: 0 },
    ],
    parentHashes: ["p0"],
  };

  const modifiedCommit: CommitData = {
    hash: "c2",
    authorName: "Bob Martinez",
    authorEmail: "bob@acme.com",
    date: "2024-02-01T00:00:00Z",
    message: "fix: tweak payments",
    filesChanged: [
      { path: "src/payments/handler.ts", status: "modified", additions: 5, deletions: 3 },
    ],
    parentHashes: ["c1"],
  };

  it("creates one PERSON entity per distinct author with commit-count frequency", () => {
    const { entities } = buildOwnershipGraph([addedCommit, modifiedCommit]);
    const people = entities.filter((e) => e.type === EntityType.PERSON);

    expect(people.map((p) => p.name).sort()).toEqual(["Alice Chen", "Bob Martinez"]);

    const alice = people.find((p) => p.name === "Alice Chen")!;
    expect(alice.id).toBe(generateEntityId(EntityType.PERSON, "Alice Chen"));
    expect(alice.frequency).toBe(1);
    expect(alice.firstSeen).toBe("2024-01-01T00:00:00Z");
    expect(alice.lastSeen).toBe("2024-01-01T00:00:00Z");
  });

  it("emits AUTHORED for added files and MODIFIED for modified-only files", () => {
    const { relations } = buildOwnershipGraph([addedCommit, modifiedCommit]);

    const aliceId = generateEntityId(EntityType.PERSON, "Alice Chen");
    const bobId = generateEntityId(EntityType.PERSON, "Bob Martinez");
    const billingId = generateEntityId(EntityType.MODULE, "src/billing");
    const paymentsId = generateEntityId(EntityType.MODULE, "src/payments");

    const aliceBilling = relations.find(
      (r) => r.sourceId === aliceId && r.targetId === billingId,
    )!;
    expect(aliceBilling.type).toBe(RelationType.AUTHORED);

    const bobPayments = relations.find((r) => r.sourceId === bobId && r.targetId === paymentsId)!;
    expect(bobPayments.type).toBe(RelationType.MODIFIED);
  });

  it("resolves to AUTHORED when the same author both added and later modified a module", () => {
    const commits: CommitData[] = [
      addedCommit,
      {
        hash: "c3",
        authorName: "Alice Chen",
        authorEmail: "alice@acme.com",
        date: "2024-03-01T00:00:00Z",
        message: "fix: tweak billing",
        filesChanged: [
          { path: "src/billing/processor.ts", status: "modified", additions: 2, deletions: 1 },
        ],
        parentHashes: ["c2"],
      },
    ];
    const { relations } = buildOwnershipGraph(commits);

    const aliceId = generateEntityId(EntityType.PERSON, "Alice Chen");
    const billingId = generateEntityId(EntityType.MODULE, "src/billing");
    const edges = relations.filter((r) => r.sourceId === aliceId && r.targetId === billingId);

    // A single merged edge, typed AUTHORED (the stronger signal), spanning both commits.
    expect(edges).toHaveLength(1);
    expect(edges[0]!.type).toBe(RelationType.AUTHORED);
    expect(edges[0]!.firstSeen).toBe("2024-01-01T00:00:00Z");
    expect(edges[0]!.lastSeen).toBe("2024-03-01T00:00:00Z");
  });

  it("canonicalizes an author with the same email but different name spellings", () => {
    const commits: CommitData[] = [
      addedCommit, // "Alice Chen" / alice@acme.com
      {
        hash: "c4",
        authorName: "alice", // different spelling, same email
        authorEmail: "alice@acme.com",
        date: "2024-04-01T00:00:00Z",
        message: "feat: more billing",
        filesChanged: [
          { path: "src/billing/processor.ts", status: "modified", additions: 1, deletions: 0 },
        ],
        parentHashes: ["c3"],
      },
    ];
    const people = buildOwnershipGraph(commits).entities.filter(
      (e) => e.type === EntityType.PERSON,
    );

    // One person, not two — collapsed by email. frequency counts both commits.
    expect(people).toHaveLength(1);
    expect(people[0]!.frequency).toBe(2);
  });

  it("skips merge commits (parentHashes.length > 1)", () => {
    const mergeCommit: CommitData = {
      hash: "m1",
      authorName: "Merger",
      authorEmail: "merge@acme.com",
      date: "2024-05-01T00:00:00Z",
      message: "merge branch",
      filesChanged: [{ path: "src/x/y.ts", status: "modified", additions: 9, deletions: 9 }],
      parentHashes: ["a", "b"],
    };
    const { entities } = buildOwnershipGraph([mergeCommit]);
    expect(entities.filter((e) => e.name === "Merger")).toHaveLength(0);
  });
});

describe("build: deterministic ownership persisted with NO LLM extraction", () => {
  let db: Database.Database;
  let store: Store;

  beforeEach(() => {
    ({ db, store } = createTestStore());
  });
  afterEach(() => db.close());

  it("creates PERSON entities and AUTHORED/MODIFIED edges from authors with empty extractions", () => {
    const commits: CommitData[] = [
      {
        hash: "h1",
        authorName: "Alice Chen",
        authorEmail: "alice@acme.com",
        date: "2024-01-01T00:00:00Z",
        message: "feat: add billing",
        filesChanged: [
          { path: "src/billing/processor.ts", status: "added", additions: 30, deletions: 0 },
        ],
        parentHashes: ["p0"],
      },
      {
        hash: "h2",
        authorName: "Bob Martinez",
        authorEmail: "bob@acme.com",
        date: "2024-02-01T00:00:00Z",
        message: "fix: tweak billing",
        filesChanged: [
          { path: "src/billing/processor.ts", status: "modified", additions: 4, deletions: 2 },
        ],
        parentHashes: ["h1"],
      },
    ];

    // No text units, no extractions, no LLM relations — purely deterministic.
    build(store, {
      textUnits: [],
      entities: [],
      relations: [],
      extractions: new Map(),
      commits,
    });

    const aliceId = generateEntityId(EntityType.PERSON, "Alice Chen");
    const bobId = generateEntityId(EntityType.PERSON, "Bob Martinez");
    const billingId = generateEntityId(EntityType.MODULE, "src/billing");

    // PERSON + MODULE entities exist deterministically.
    expect(store.getEntity(aliceId)?.type).toBe(EntityType.PERSON);
    expect(store.getEntity(bobId)?.type).toBe(EntityType.PERSON);
    expect(store.getEntity(billingId)?.type).toBe(EntityType.MODULE);

    // Ownership edges exist and carry the right types.
    const aliceEdge = store.getRelation(
      generateRelationId(RelationType.AUTHORED, aliceId, billingId),
    )!;
    expect(aliceEdge.type).toBe(RelationType.AUTHORED);
    expect(aliceEdge.sourceId).toBe(aliceId);
    expect(aliceEdge.targetId).toBe(billingId);
    expect(aliceEdge.firstSeen).toBe("2024-01-01T00:00:00Z");

    const bobEdge = store.getRelation(
      generateRelationId(RelationType.MODIFIED, bobId, billingId),
    )!;
    expect(bobEdge.type).toBe(RelationType.MODIFIED);
  });

  it("merges an LLM-emitted PERSON duplicate via ON CONFLICT (additive frequency, LLM description wins)", () => {
    const aliceId = generateEntityId(EntityType.PERSON, "Alice Chen");
    const billingId = generateEntityId(EntityType.MODULE, "src/billing");

    const tu: TextUnit = {
      id: "tu:1",
      content: "Alice authored billing",
      commitHashes: ["h1"],
      dateRange: { start: "2024-01-01", end: "2024-01-02" },
      entityIds: [aliceId],
      relationIds: [],
    };

    // LLM also extracted "Alice Chen" with a rich description.
    const llmAlice: Entity = {
      id: aliceId,
      type: EntityType.PERSON,
      name: "Alice Chen",
      aliases: [],
      description: "Lead engineer who owns billing",
      firstSeen: "",
      lastSeen: "",
      frequency: 0,
      metadata: {},
    };

    build(store, {
      textUnits: [tu],
      entities: [llmAlice],
      relations: [],
      extractions: new Map([
        [
          "tu:1",
          {
            entities: [
              { name: "Alice Chen", type: EntityType.PERSON, description: "Lead engineer who owns billing" },
            ],
            relations: [],
          },
        ],
      ]),
      commits: [
        {
          hash: "h1",
          authorName: "Alice Chen",
          authorEmail: "alice@acme.com",
          date: "2024-01-01T00:00:00Z",
          message: "feat: add billing",
          filesChanged: [
            { path: "src/billing/processor.ts", status: "added", additions: 30, deletions: 0 },
          ],
          parentHashes: ["p0"],
        },
      ],
    });

    const alice = store.getEntity(aliceId)!;
    // Exactly one Alice entity — the deterministic and LLM rows merged.
    const allPeople = store.getAllEntities().filter((e) => e.type === EntityType.PERSON);
    expect(allPeople).toHaveLength(1);
    // LLM description survives (deterministic empty description must not clobber it).
    expect(alice.description).toBe("Lead engineer who owns billing");
    // frequency is additive: deterministic (1 commit) + LLM (1 text-unit occurrence).
    expect(alice.frequency).toBe(2);

    // And the deterministic AUTHORED edge is present.
    const edge = store.getRelation(generateRelationId(RelationType.AUTHORED, aliceId, billingId))!;
    expect(edge.type).toBe(RelationType.AUTHORED);
  });
});
