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
import { getGraphData, getEntityDetail, getStatsData } from "../../src/viz/api.js";

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
