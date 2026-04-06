import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import type { Store } from "../../src/store/queries.js";
import { createPopulatedStore } from "../helpers/sample-store.js";
import { registerResources } from "../../src/mcp/resources.js";

describe("MCP resources — populated index", () => {
  let db: Database.Database;
  let store: Store;
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    ({ db, store } = createPopulatedStore());

    server = new McpServer({ name: "git-oracle-test", version: "0.1.0" });
    const getStore = () => store;
    registerResources(server, getStore);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    db.close();
  });

  it("git-oracle://stats returns valid JSON with counts", async () => {
    const result = await client.readResource({ uri: "git-oracle://stats" });
    const text = (result.contents[0] as { text: string }).text;
    const data = JSON.parse(text);

    expect(data.entities).toBeGreaterThan(0);
    expect(data.relations).toBeGreaterThan(0);
    expect(data.communities).toBeGreaterThan(0);
    expect(data.textUnits).toBeGreaterThan(0);
    expect(data.lastIndexedCommit).toBe("bbb222");
    expect(data.lastIndexedAt).toBeTruthy();
  });

  it("git-oracle://graph/summary returns Markdown with headers", async () => {
    const result = await client.readResource({
      uri: "git-oracle://graph/summary",
    });
    const text = (result.contents[0] as { text: string }).text;

    expect(text).toContain("Knowledge Graph Summary");
    expect(text).toContain("Entities:");
    expect(text).toContain("Top Communities");
  });
});

describe("MCP resources — empty index", () => {
  let db: Database.Database;
  let store: Store;
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    const { openDatabase } = await import("../../src/store/db.js");
    const { Store: StoreClass } = await import("../../src/store/queries.js");
    db = openDatabase(":memory:");
    store = new StoreClass(db);

    server = new McpServer({ name: "git-oracle-test", version: "0.1.0" });
    const getStore = () => store;
    registerResources(server, getStore);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    db.close();
  });

  it("git-oracle://stats returns zero counts without crash", async () => {
    const result = await client.readResource({ uri: "git-oracle://stats" });
    const text = (result.contents[0] as { text: string }).text;
    const data = JSON.parse(text);

    expect(data.entities).toBe(0);
    expect(data.relations).toBe(0);
    expect(data.communities).toBe(0);
  });

  it("git-oracle://graph/summary returns content without crash", async () => {
    const result = await client.readResource({
      uri: "git-oracle://graph/summary",
    });
    const text = (result.contents[0] as { text: string }).text;

    expect(text).toContain("Knowledge Graph Summary");
    expect(text).toContain("Entities: 0");
  });
});
