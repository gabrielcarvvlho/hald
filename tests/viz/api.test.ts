import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
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
import {
  getGraphData,
  getEntityDetail,
  getStatsData,
  getCommunityDetail,
} from "../../src/viz/api.js";

// Build a store with `entityCount` entities and a dense web of relations
// so we can exercise the node/edge caps. Frequencies and weights are
// monotonic in the index so the "top-N" survivors are predictable: the
// highest-index entities/edges are the highest-value ones.
function createLargeStore(
  entityCount: number,
  edgeCount: number,
): { db: Database.Database; store: Store } {
  const db = openDatabase(":memory:");
  const store = new Store(db);

  for (let i = 0; i < entityCount; i++) {
    const e: Entity = {
      id: `module:m${String(i).padStart(5, "0")}`,
      type: EntityType.MODULE,
      name: `module-${i}`,
      aliases: [],
      description: "",
      firstSeen: "2025-01-01",
      lastSeen: "2026-01-01",
      frequency: i, // higher index → higher frequency → kept first
      metadata: {},
    };
    store.upsertEntity(e);
  }

  // Generate DISTINCT undirected pairs among the highest-frequency
  // entities (the survivors of the node cap), so the deduped edge set is
  // large enough to exercise the edge cap. We enumerate pairs (i, j) over
  // the top region with a nested walk; weight increases monotonically so
  // the "top-M by weight" survivors are predictable.
  //
  // Endpoints are confined to the top `span` nodes (highest indices, i.e.
  // highest frequency) so survivors stay connected after the node cap.
  const span = Math.min(entityCount, 480);
  const base = entityCount - span; // lowest index used as an endpoint
  let made = 0;
  outer: for (let i = base; i < entityCount && made < edgeCount; i++) {
    for (let j = i + 1; j < entityCount && made < edgeCount; j++) {
      const r: Relation = {
        id: `rel:${String(made).padStart(6, "0")}`,
        type: RelationType.CO_CHANGED,
        sourceId: `module:m${String(i).padStart(5, "0")}`,
        targetId: `module:m${String(j).padStart(5, "0")}`,
        weight: made + 1,
        description: "",
        evidence: [],
        firstSeen: "2025-01-01",
        lastSeen: "2026-01-01",
      };
      store.upsertRelation(r);
      made++;
      if (made >= edgeCount) break outer;
    }
  }

  return { db, store };
}

function createFixtureStore(): { db: Database.Database; store: Store } {
  const db = openDatabase(":memory:");
  const store = new Store(db);

  const alice: Entity = {
    id: "person:alice",
    type: EntityType.PERSON,
    name: "Alice",
    aliases: ["alice@example.com"],
    description: "Lead developer",
    firstSeen: "2025-01-01",
    lastSeen: "2026-03-01",
    frequency: 42,
    metadata: {},
  };

  const authModule: Entity = {
    id: "module:auth",
    type: EntityType.MODULE,
    name: "auth-service",
    aliases: ["auth"],
    description: "Authentication and authorization module",
    firstSeen: "2025-01-01",
    lastSeen: "2026-03-01",
    frequency: 28,
    metadata: {},
  };

  const payments: Entity = {
    id: "module:payments",
    type: EntityType.MODULE,
    name: "payments",
    aliases: [],
    description: "Payment processing module",
    firstSeen: "2025-06-01",
    lastSeen: "2026-02-15",
    frequency: 15,
    metadata: {},
  };

  const jwt: Entity = {
    id: "tech:jwt",
    type: EntityType.TECHNOLOGY,
    name: "JWT",
    aliases: ["JSON Web Token"],
    description: "Token-based authentication",
    firstSeen: "2025-01-01",
    lastSeen: "2026-01-01",
    frequency: 8,
    metadata: {},
  };

  store.upsertEntity(alice);
  store.upsertEntity(authModule);
  store.upsertEntity(payments);
  store.upsertEntity(jwt);

  const rel1: Relation = {
    id: "rel:1",
    type: RelationType.AUTHORED,
    sourceId: "person:alice",
    targetId: "module:auth",
    weight: 15,
    description: "Alice is the primary author of auth-service",
    evidence: ["tu:1"],
    firstSeen: "2025-01-01",
    lastSeen: "2026-03-01",
  };

  const rel2: Relation = {
    id: "rel:2",
    type: RelationType.CO_CHANGED,
    sourceId: "module:auth",
    targetId: "module:payments",
    weight: 5,
    description: "Often changed together during checkout flow updates",
    evidence: ["tu:2"],
    firstSeen: "2025-06-01",
    lastSeen: "2026-02-15",
  };

  const rel3: Relation = {
    id: "rel:3",
    type: RelationType.USES,
    sourceId: "module:auth",
    targetId: "tech:jwt",
    weight: 8,
    description: "Auth service uses JWT for token management",
    evidence: ["tu:1"],
    firstSeen: "2025-01-01",
    lastSeen: "2026-01-01",
  };

  store.upsertRelation(rel1);
  store.upsertRelation(rel2);
  store.upsertRelation(rel3);

  const tu1: TextUnit = {
    id: "tu:1",
    content: "Alice implemented JWT-based auth in auth-service",
    commitHashes: ["abc1234567890", "def5678901234"],
    dateRange: { start: "2025-01-01", end: "2025-01-15" },
    entityIds: ["person:alice", "module:auth", "tech:jwt"],
    relationIds: ["rel:1", "rel:3"],
  };

  const tu2: TextUnit = {
    id: "tu:2",
    content: "Updated auth-service and payments for new checkout flow",
    commitHashes: ["ghi9012345678"],
    dateRange: { start: "2025-06-01", end: "2025-06-15" },
    entityIds: ["module:auth", "module:payments"],
    relationIds: ["rel:2"],
  };

  store.insertTextUnit(tu1);
  store.insertTextUnit(tu2);

  const commit1: CommitData = {
    hash: "abc1234567890",
    authorName: "Alice",
    authorEmail: "alice@example.com",
    date: "2025-01-10T10:00:00Z",
    message: "feat: implement JWT authentication",
    filesChanged: [],
    parentHashes: [],
  };

  const commit2: CommitData = {
    hash: "def5678901234",
    authorName: "Alice",
    authorEmail: "alice@example.com",
    date: "2025-01-15T14:00:00Z",
    message: "fix: token refresh edge case",
    filesChanged: [],
    parentHashes: ["abc1234567890"],
  };

  const commit3: CommitData = {
    hash: "ghi9012345678",
    authorName: "Alice",
    authorEmail: "alice@example.com",
    date: "2025-06-10T09:00:00Z",
    message: "feat: integrate auth with payment checkout",
    filesChanged: [],
    parentHashes: ["def5678901234"],
  };

  store.insertCommit(commit1, "tu:1");
  store.insertCommit(commit2, "tu:1");
  store.insertCommit(commit3, "tu:2");

  const community: Community = {
    id: "comm:1",
    level: 0,
    title: "Auth & Identity",
    summary: "Core authentication and identity management cluster including JWT token handling.",
    entityIds: ["person:alice", "module:auth", "tech:jwt"],
    childIds: [],
  };

  store.upsertCommunity(community);

  return { db, store };
}

// ================================================================
// getGraphData
// ================================================================

describe("getGraphData", () => {
  let store: Store;
  let db: Database.Database;

  beforeEach(() => {
    ({ db, store } = createFixtureStore());
  });
  afterEach(() => db.close());

  it("returns all entities as nodes with layout positions", () => {
    const result = getGraphData(store);

    expect(result.nodes).toHaveLength(4);
    for (const node of result.nodes) {
      expect(node).toHaveProperty("id");
      expect(node).toHaveProperty("name");
      expect(node).toHaveProperty("type");
      expect(node).toHaveProperty("x");
      expect(node).toHaveProperty("y");
      expect(typeof node.x).toBe("number");
      expect(typeof node.y).toBe("number");
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });

  it("deduplicates edges by node pair, keeping highest weight", () => {
    const result = getGraphData(store);

    // 3 relations between 3 distinct pairs → 3 edges
    expect(result.edges).toHaveLength(3);

    const authPaymentsEdge = result.edges.find(
      (e) =>
        (e.source === "module:auth" && e.target === "module:payments") ||
        (e.source === "module:payments" && e.target === "module:auth"),
    );
    expect(authPaymentsEdge).toBeDefined();
    expect(authPaymentsEdge!.weight).toBe(5);
  });

  it("assigns community colors from the palette", () => {
    const result = getGraphData(store);

    expect(result.communities).toHaveLength(1);
    expect(result.communities[0].title).toBe("Auth & Identity");
    expect(result.communities[0].color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("maps entities to their community via communityId", () => {
    const result = getGraphData(store);

    const alice = result.nodes.find((n) => n.id === "person:alice");
    const payments = result.nodes.find((n) => n.id === "module:payments");

    expect(alice!.communityId).toBe("comm:1");
    expect(payments!.communityId).toBeNull(); // not in any community
  });
});

// ================================================================
// getGraphData — node/edge caps (large repos)
// ================================================================

describe("getGraphData caps", () => {
  it("returns null truncation metadata when under the caps", () => {
    const { db, store } = createLargeStore(20, 30);
    try {
      const result = getGraphData(store);
      expect(result.truncated).toBeNull();
      expect(result.nodes.length).toBe(20);
    } finally {
      db.close();
    }
  });

  it("caps nodes to the top-N by frequency with truncation metadata", () => {
    // 600 entities (> default 500 cap), small edge set.
    const { db, store } = createLargeStore(600, 50);
    try {
      const result = getGraphData(store);

      expect(result.nodes.length).toBe(500);
      expect(result.truncated).not.toBeNull();
      expect(result.truncated!.shownNodes).toBe(500);
      expect(result.truncated!.totalNodes).toBe(600);

      // Survivors are the highest-frequency entities (index 100..599).
      const minFreq = Math.min(...result.nodes.map((n) => n.frequency));
      expect(minFreq).toBe(100);
      for (const n of result.nodes) {
        expect(n.frequency).toBeGreaterThanOrEqual(100);
      }

      // Every returned edge connects two surviving nodes.
      const ids = new Set(result.nodes.map((n) => n.id));
      for (const e of result.edges) {
        expect(ids.has(e.source)).toBe(true);
        expect(ids.has(e.target)).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("caps edges to the top-M by weight with truncation metadata", () => {
    // Stay under the node cap (300 < 500) but exceed the edge cap.
    const { db, store } = createLargeStore(300, 2500);
    try {
      const result = getGraphData(store, 500, 2000);

      expect(result.nodes.length).toBe(300);
      expect(result.edges.length).toBeLessThanOrEqual(2000);
      expect(result.truncated).not.toBeNull();
      expect(result.truncated!.shownEdges).toBe(result.edges.length);
      expect(result.truncated!.totalEdges).toBeGreaterThan(2000);

      // Kept edges are the heaviest ones — every kept edge's weight is
      // ≥ the heaviest dropped edge would have been.
      const weights = result.edges.map((e) => e.weight);
      const minKept = Math.min(...weights);
      expect(minKept).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("respects explicit cap arguments", () => {
    const { db, store } = createLargeStore(100, 200);
    try {
      const result = getGraphData(store, 10, 20);
      expect(result.nodes.length).toBe(10);
      expect(result.edges.length).toBeLessThanOrEqual(20);
      expect(result.truncated).not.toBeNull();
      expect(result.truncated!.totalNodes).toBe(100);
    } finally {
      db.close();
    }
  });
});

// ================================================================
// getEntityDetail
// ================================================================

describe("getEntityDetail", () => {
  let store: Store;
  let db: Database.Database;

  beforeEach(() => {
    ({ db, store } = createFixtureStore());
  });
  afterEach(() => db.close());

  it("returns null for unknown entity ID", () => {
    const result = getEntityDetail(store, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns entity with relations sorted by weight desc", () => {
    const result = getEntityDetail(store, "module:auth");

    expect(result).not.toBeNull();
    expect(result!.entity.name).toBe("auth-service");
    expect(result!.entity.type).toBe(EntityType.MODULE);

    // auth-service has 3 relations: AUTHORED(15), USES(8), CO_CHANGED(5)
    expect(result!.relations.length).toBe(3);
    expect(result!.relations[0].weight).toBeGreaterThanOrEqual(result!.relations[1].weight);
    expect(result!.relations[1].weight).toBeGreaterThanOrEqual(result!.relations[2].weight);
  });

  it("includes direction for each relation", () => {
    const result = getEntityDetail(store, "module:auth");

    const authored = result!.relations.find((r) => r.type === "AUTHORED");
    expect(authored!.direction).toBe("incoming"); // alice → auth, so auth is target → incoming
    expect(authored!.targetId).toBe("person:alice");

    const uses = result!.relations.find((r) => r.type === "USES");
    expect(uses!.direction).toBe("outgoing"); // auth → jwt
    expect(uses!.targetId).toBe("tech:jwt");
  });

  it("includes communities", () => {
    const result = getEntityDetail(store, "module:auth");
    expect(result!.communities).toHaveLength(1);
    expect(result!.communities[0].title).toBe("Auth & Identity");
  });

  it("includes recent commits sorted by date desc", () => {
    const result = getEntityDetail(store, "module:auth");

    // auth-service is in tu:1 (2 commits) and tu:2 (1 commit) → 3 total
    expect(result!.recentCommits.length).toBe(3);
    // Most recent first
    expect(result!.recentCommits[0].message).toContain("integrate auth");
    expect(result!.recentCommits[1].message).toContain("token refresh");
  });
});

// ================================================================
// getStatsData
// ================================================================

describe("getStatsData", () => {
  let store: Store;
  let db: Database.Database;

  beforeEach(() => {
    ({ db, store } = createFixtureStore());
  });
  afterEach(() => db.close());

  it("returns correct counts", () => {
    const result = getStatsData(store);

    expect(result.entities).toBe(4);
    expect(result.relations).toBe(3);
    expect(result.communities).toBe(1);
    expect(result.commits).toBe(3);
  });
});

// ================================================================
// getCommunityDetail (Explain cluster overlay)
// ================================================================

describe("getCommunityDetail", () => {
  let store: Store;
  let db: Database.Database;

  beforeEach(() => {
    ({ db, store } = createFixtureStore());
  });
  afterEach(() => db.close());

  it("returns null for unknown community ID", () => {
    expect(getCommunityDetail(store, "comm:unknown")).toBeNull();
  });

  it("returns id, title, summary for a known community", () => {
    const result = getCommunityDetail(store, "comm:1");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("comm:1");
    expect(result!.title).toBe("Auth & Identity");
    expect(result!.summary).toContain("authentication");
  });

  it("returns top entities sorted by frequency desc", () => {
    const result = getCommunityDetail(store, "comm:1");

    expect(result).not.toBeNull();
    // Fixture has alice (42), auth (28), jwt (lower)
    expect(result!.topEntities.length).toBeGreaterThan(0);
    expect(result!.topEntities[0].name).toBe("Alice");
    expect(result!.topEntities[0].frequency).toBe(42);
    // Sorted desc
    for (let i = 1; i < result!.topEntities.length; i++) {
      expect(result!.topEntities[i - 1].frequency).toBeGreaterThanOrEqual(
        result!.topEntities[i].frequency,
      );
    }
  });

  it("ties broken by name ascending for deterministic ordering", () => {
    // Add a community with two entities at the same frequency.
    const charlie: Entity = {
      id: "person:charlie",
      type: EntityType.PERSON,
      name: "Charlie",
      aliases: [],
      description: "",
      firstSeen: "2025-01-01",
      lastSeen: "2025-12-01",
      frequency: 10,
      metadata: {},
    };
    const bob: Entity = {
      id: "person:bob",
      type: EntityType.PERSON,
      name: "Bob",
      aliases: [],
      description: "",
      firstSeen: "2025-01-01",
      lastSeen: "2025-12-01",
      frequency: 10,
      metadata: {},
    };
    store.upsertEntity(charlie);
    store.upsertEntity(bob);

    const tieComm: Community = {
      id: "comm:tie",
      level: 0,
      title: "Ties",
      summary: "",
      entityIds: ["person:charlie", "person:bob"],
      childIds: [],
    };
    store.upsertCommunity(tieComm);

    const result = getCommunityDetail(store, "comm:tie");
    expect(result!.topEntities[0].name).toBe("Bob");
    expect(result!.topEntities[1].name).toBe("Charlie");
  });

  it("caps top entities at 5 even if community has more", () => {
    // Add 7 entities to a single community.
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const e: Entity = {
        id: `person:e${i}`,
        type: EntityType.PERSON,
        name: `Entity${i}`,
        aliases: [],
        description: "",
        firstSeen: "2025-01-01",
        lastSeen: "2025-12-01",
        frequency: 100 - i, // decreasing frequency
        metadata: {},
      };
      store.upsertEntity(e);
      ids.push(e.id);
    }
    const big: Community = {
      id: "comm:big",
      level: 0,
      title: "Big",
      summary: "",
      entityIds: ids,
      childIds: [],
    };
    store.upsertCommunity(big);

    const result = getCommunityDetail(store, "comm:big");
    expect(result!.topEntities).toHaveLength(5);
    // Highest frequency first
    expect(result!.topEntities[0].name).toBe("Entity0");
  });

  it("returns empty topEntities when community has zero entities", () => {
    const empty: Community = {
      id: "comm:empty",
      level: 0,
      title: "Empty",
      summary: "Lonely cluster",
      entityIds: [],
      childIds: [],
    };
    store.upsertCommunity(empty);

    const result = getCommunityDetail(store, "comm:empty");
    expect(result).not.toBeNull();
    expect(result!.topEntities).toEqual([]);
  });

  it("skips entities that no longer exist in the store", () => {
    const ghost: Community = {
      id: "comm:ghost",
      level: 0,
      title: "Ghost",
      summary: "",
      entityIds: ["person:alice", "person:nonexistent"],
      childIds: [],
    };
    store.upsertCommunity(ghost);

    const result = getCommunityDetail(store, "comm:ghost");
    expect(result!.topEntities).toHaveLength(1);
    expect(result!.topEntities[0].id).toBe("person:alice");
  });
});
