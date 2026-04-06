import type Database from "better-sqlite3";
import { openDatabase } from "../../src/store/db.js";
import { Store } from "../../src/store/queries.js";
import { EntityType, RelationType } from "../../src/shared/types.js";
import type { Entity, Relation, TextUnit, Community } from "../../src/shared/types.js";

/** Creates an in-memory store populated with sample data for query tests. */
export function createPopulatedStore(): { db: Database.Database; store: Store } {
  const db = openDatabase(":memory:");
  const store = new Store(db);

  // === Entities ===
  const entities: Entity[] = [
    {
      id: "person:alice-chen",
      type: EntityType.PERSON,
      name: "Alice Chen",
      aliases: ["alice"],
      description: "Lead developer driving the payments gRPC migration",
      firstSeen: "2024-01-01",
      lastSeen: "2024-06-15",
      frequency: 12,
      metadata: { email: "alice@acme.com" },
    },
    {
      id: "person:bob-martinez",
      type: EntityType.PERSON,
      name: "Bob Martinez",
      aliases: ["bob"],
      description: "Developer who maintains the billing module",
      firstSeen: "2024-02-01",
      lastSeen: "2024-05-20",
      frequency: 8,
      metadata: { email: "bob@acme.com" },
    },
    {
      id: "person:carlos-ruiz",
      type: EntityType.PERSON,
      name: "Carlos Ruiz",
      aliases: [],
      description: "Documentation and API design",
      firstSeen: "2024-03-01",
      lastSeen: "2024-04-01",
      frequency: 3,
      metadata: {},
    },
    {
      id: "module:src/payments",
      type: EntityType.MODULE,
      name: "src/payments",
      aliases: ["payments"],
      description: "Payments service module, recently migrated to gRPC",
      firstSeen: "2024-01-15",
      lastSeen: "2024-06-10",
      frequency: 15,
      metadata: {},
    },
    {
      id: "module:src/billing",
      type: EntityType.MODULE,
      name: "src/billing",
      aliases: ["billing"],
      description: "Billing processor that depends on payments service",
      firstSeen: "2024-02-01",
      lastSeen: "2024-06-10",
      frequency: 10,
      metadata: {},
    },
    {
      id: "module:src/middleware",
      type: EntityType.MODULE,
      name: "src/middleware",
      aliases: [],
      description: "Auth middleware layer",
      firstSeen: "2024-03-01",
      lastSeen: "2024-05-01",
      frequency: 4,
      metadata: {},
    },
    {
      id: "technology:grpc",
      type: EntityType.TECHNOLOGY,
      name: "gRPC",
      aliases: ["grpc"],
      description: "RPC framework adopted for inter-service communication",
      firstSeen: "2024-03-01",
      lastSeen: "2024-06-10",
      frequency: 6,
      metadata: {},
    },
    {
      id: "decision:rest-to-grpc-migration",
      type: EntityType.DECISION,
      name: "REST to gRPC migration (payments)",
      aliases: [],
      description:
        "Architectural decision to migrate payments from REST to gRPC for type safety and performance",
      firstSeen: "2024-03-01",
      lastSeen: "2024-06-01",
      frequency: 5,
      metadata: {},
    },
  ];

  for (const e of entities) store.upsertEntity(e);

  // === Relations ===
  const relations: Relation[] = [
    {
      id: "rel:alice-payments-auth",
      type: RelationType.AUTHORED,
      sourceId: "person:alice-chen",
      targetId: "module:src/payments",
      weight: 9,
      description: "Alice implemented the gRPC migration for payments",
      evidence: ["tu:001"],
      firstSeen: "2024-01-15",
      lastSeen: "2024-06-10",
    },
    {
      id: "rel:alice-middleware-auth",
      type: RelationType.AUTHORED,
      sourceId: "person:alice-chen",
      targetId: "module:src/middleware",
      weight: 4,
      description: "Alice created the auth middleware",
      evidence: ["tu:002"],
      firstSeen: "2024-03-01",
      lastSeen: "2024-05-01",
    },
    {
      id: "rel:bob-billing-auth",
      type: RelationType.AUTHORED,
      sourceId: "person:bob-martinez",
      targetId: "module:src/billing",
      weight: 7,
      description: "Bob maintains the billing processor",
      evidence: ["tu:001", "tu:003"],
      firstSeen: "2024-02-01",
      lastSeen: "2024-05-20",
    },
    {
      id: "rel:bob-payments-mod",
      type: RelationType.MODIFIED,
      sourceId: "person:bob-martinez",
      targetId: "module:src/payments",
      weight: 3,
      description: "Bob updated billing integration with payments",
      evidence: ["tu:003"],
      firstSeen: "2024-03-15",
      lastSeen: "2024-05-20",
    },
    {
      id: "rel:billing-payments-dep",
      type: RelationType.DEPENDS_ON,
      sourceId: "module:src/billing",
      targetId: "module:src/payments",
      weight: 8,
      description: "Billing calls payments service for charges",
      evidence: ["tu:003"],
      firstSeen: "2024-02-01",
      lastSeen: "2024-06-10",
    },
    {
      id: "rel:billing-payments-cochange",
      type: RelationType.CO_CHANGED,
      sourceId: "module:src/billing",
      targetId: "module:src/payments",
      weight: 5,
      description: "Changed together during gRPC migration",
      evidence: [],
      firstSeen: "2024-03-01",
      lastSeen: "2024-06-01",
    },
    {
      id: "rel:payments-grpc-uses",
      type: RelationType.USES,
      sourceId: "module:src/payments",
      targetId: "technology:grpc",
      weight: 9,
      description: "Payments service uses gRPC for its interface",
      evidence: ["tu:001"],
      firstSeen: "2024-03-01",
      lastSeen: "2024-06-10",
    },
    {
      id: "rel:alice-grpc-introduced",
      type: RelationType.INTRODUCED,
      sourceId: "person:alice-chen",
      targetId: "technology:grpc",
      weight: 9,
      description: "Alice introduced gRPC to the codebase",
      evidence: ["tu:001"],
      firstSeen: "2024-03-01",
      lastSeen: "2024-03-01",
    },
    {
      id: "rel:alice-decision-decided",
      type: RelationType.DECIDED,
      sourceId: "person:alice-chen",
      targetId: "decision:rest-to-grpc-migration",
      weight: 9,
      description: "Alice led the REST to gRPC migration decision",
      evidence: ["tu:001"],
      firstSeen: "2024-03-01",
      lastSeen: "2024-06-01",
    },
  ];

  for (const r of relations) store.upsertRelation(r);

  // === Text Units ===
  const textUnits: TextUnit[] = [
    {
      id: "tu:001",
      content:
        "Alice migrated payments from REST to gRPC, adding proto definitions and rewriting handlers",
      commitHashes: ["abc123", "def456"],
      dateRange: { start: "2024-03-01", end: "2024-03-05" },
      entityIds: [
        "person:alice-chen",
        "module:src/payments",
        "technology:grpc",
        "decision:rest-to-grpc-migration",
      ],
      relationIds: ["rel:alice-payments-auth"],
    },
    {
      id: "tu:002",
      content: "Alice added authentication middleware for request validation",
      commitHashes: ["aaa111"],
      dateRange: { start: "2024-03-10", end: "2024-03-10" },
      entityIds: ["person:alice-chen", "module:src/middleware"],
      relationIds: ["rel:alice-middleware-auth"],
    },
    {
      id: "tu:003",
      content: "Bob updated billing processor to use new gRPC payments client instead of REST",
      commitHashes: ["bbb222"],
      dateRange: { start: "2024-03-15", end: "2024-03-15" },
      entityIds: ["person:bob-martinez", "module:src/billing", "module:src/payments"],
      relationIds: ["rel:bob-billing-auth", "rel:bob-payments-mod"],
    },
  ];

  for (const tu of textUnits) store.insertTextUnit(tu);

  // === Communities ===
  const communities: Community[] = [
    {
      id: "comm:0:0",
      level: 0,
      title: "Payments Service & gRPC Migration",
      summary:
        "This community centers on the payments service and its migration from REST to gRPC. Alice Chen led the migration. The billing module depends on payments for charge operations. gRPC was introduced for type safety and performance.",
      entityIds: [
        "person:alice-chen",
        "module:src/payments",
        "technology:grpc",
        "decision:rest-to-grpc-migration",
      ],
      childIds: [],
    },
    {
      id: "comm:0:1",
      level: 0,
      title: "Billing & Integration",
      summary:
        "This community covers the billing module and its integration with the payments service. Bob Martinez is the primary maintainer. The billing processor was updated to use the gRPC client after the payments migration.",
      entityIds: ["person:bob-martinez", "module:src/billing"],
      childIds: [],
    },
  ];

  for (const c of communities) store.upsertCommunity(c);

  // === Meta ===
  store.setMeta("last_indexed_commit", "bbb222");
  store.setMeta("last_indexed_at", "2024-06-15T10:00:00Z");

  return { db, store };
}
