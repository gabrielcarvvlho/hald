import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/store/db.js";
import { Store } from "../../src/store/queries.js";
import { registerTools } from "../../src/mcp/tools.js";
import { QueryEmbedder } from "../../src/query/similarity.js";
import { EntityType, RelationType } from "../../src/shared/types.js";
import type { Entity, Relation } from "../../src/shared/types.js";

// A "hub" entity wired to many modules. getRelationsForEntity has no LIMIT,
// so hald_get_entity must cap rendered relations (top 50 by weight) to avoid
// dumping unbounded text into the host context.

const HUB_RELATION_COUNT = 120;
const MAX_RENDERED = 50;

function getText(result: { content: unknown }): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

describe("hald_get_entity — relation bounding", () => {
  let db: Database.Database;
  let store: Store;
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    db = openDatabase(":memory:");
    store = new Store(db);

    const hub: Entity = {
      id: "person:hub-dev",
      type: EntityType.PERSON,
      name: "Hub Dev",
      aliases: [],
      description: "Prolific author touching everything",
      firstSeen: "2024-01-01",
      lastSeen: "2024-06-01",
      frequency: 999,
      metadata: {},
    };
    store.upsertEntity(hub);

    // Many target modules + AUTHORED relations with varying weights.
    for (let i = 0; i < HUB_RELATION_COUNT; i++) {
      const moduleId = `module:src/m${i}`;
      const moduleEntity: Entity = {
        id: moduleId,
        type: EntityType.MODULE,
        name: `src/m${i}`,
        aliases: [],
        description: `Module ${i}`,
        firstSeen: "2024-01-01",
        lastSeen: "2024-06-01",
        frequency: 1,
        metadata: {},
      };
      store.upsertEntity(moduleEntity);

      const rel: Relation = {
        id: `rel:hub-m${i}`,
        type: RelationType.AUTHORED,
        sourceId: hub.id,
        targetId: moduleId,
        // Ascending weight so the heaviest edges are the highest-indexed.
        weight: i + 1,
        description: "",
        evidence: [],
        firstSeen: "2024-01-01",
        lastSeen: "2024-06-01",
      };
      store.upsertRelation(rel);
    }

    server = new McpServer({ name: "hald-test", version: "0.1.0" });
    registerTools(
      server,
      () => store,
      async () => new QueryEmbedder(null),
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    db.close();
  });

  it("caps rendered relations and footers the remainder", async () => {
    const result = await client.callTool({
      name: "hald_get_entity",
      arguments: { query: "person:hub-dev" },
    });
    expect(result.isError).toBeFalsy();
    const text = getText(result);

    // Header still reflects the TOTAL relation count.
    expect(text).toContain(`### Relationships (${HUB_RELATION_COUNT})`);

    // Only the top 50 relation bullets are rendered.
    const bulletCount = text.split("\n").filter((l) => /^- [→←]/.test(l)).length;
    expect(bulletCount).toBe(MAX_RENDERED);

    // Footer announces how many were withheld.
    const hidden = HUB_RELATION_COUNT - MAX_RENDERED;
    expect(text).toContain(`…and ${hidden} more relationships (showing top ${MAX_RENDERED} by weight)`);

    // The cap keeps the HEAVIEST edges: the top-weighted target must appear,
    // a low-weighted one must not.
    expect(text).toContain("src/m119 (weight: 120)"); // max weight — rendered
    expect(text).not.toContain("src/m0 (weight: 1)"); // min weight — withheld
  });

  it("does not add a footer when an entity has fewer than the cap", async () => {
    // A second entity with only a couple of relations.
    const small: Entity = {
      id: "person:small-dev",
      type: EntityType.PERSON,
      name: "Small Dev",
      aliases: [],
      description: "Occasional contributor",
      firstSeen: "2024-01-01",
      lastSeen: "2024-02-01",
      frequency: 2,
      metadata: {},
    };
    store.upsertEntity(small);
    store.upsertRelation({
      id: "rel:small-m0",
      type: RelationType.MODIFIED,
      sourceId: small.id,
      targetId: "module:src/m0",
      weight: 3,
      description: "",
      evidence: [],
      firstSeen: "2024-01-01",
      lastSeen: "2024-02-01",
    });

    const result = await client.callTool({
      name: "hald_get_entity",
      arguments: { query: "person:small-dev" },
    });
    const text = getText(result);
    expect(text).toContain("### Relationships (1)");
    expect(text).not.toContain("more relationship");
  });
});
