import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import type { Store } from "../../src/store/queries.js";
import { createPopulatedStore } from "../helpers/sample-store.js";
import { registerTools } from "../../src/mcp/tools.js";
import { registerResources } from "../../src/mcp/resources.js";

describe("MCP integration", () => {
  let db: Database.Database;
  let store: Store;
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    // 1. Populate an in-memory store
    ({ db, store } = createPopulatedStore());

    // 2. Create MCP server and register tools/resources
    server = new McpServer({ name: "git-oracle-test", version: "0.1.0" });
    const getStore = () => store;
    registerTools(server, getStore);
    registerResources(server, getStore);

    // 3. Connect client <-> server via in-memory transport
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

  it("lists all registered tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain("git_oracle_query");
    expect(names).toContain("git_oracle_find_expert");
    expect(names).toContain("git_oracle_trace_decision");
    expect(names).toContain("git_oracle_show_coupling");
    expect(names).toContain("git_oracle_get_path");
    expect(names).toContain("git_oracle_get_entity");
    expect(names).toContain("git_oracle_find_silos");
    expect(names).toContain("git_oracle_index");
    expect(names).toContain("git_oracle_stats");
  });

  it("git_oracle_stats returns index statistics", async () => {
    const result = await client.callTool({
      name: "git_oracle_stats",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("Entities:");
    expect(text).toContain("Relations:");
    expect(text).toContain("Communities:");
  });

  it("git_oracle_find_expert finds Alice for payments", async () => {
    const result = await client.callTool({
      name: "git_oracle_find_expert",
      arguments: { module: "src/payments", top_n: 5 },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("Alice Chen");
  });

  it("git_oracle_find_expert returns message for unknown module", async () => {
    const result = await client.callTool({
      name: "git_oracle_find_expert",
      arguments: { module: "src/nonexistent" },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("No experts found");
  });

  it("git_oracle_query returns entities for a local query", async () => {
    const result = await client.callTool({
      name: "git_oracle_query",
      arguments: { question: "who works on payments?", search_type: "local" },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("payments");
  });

  it("git_oracle_query handles global search", async () => {
    const result = await client.callTool({
      name: "git_oracle_query",
      arguments: {
        question: "what are the main architectural decisions?",
        search_type: "global",
      },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(typeof text).toBe("string");
  });

  it("git_oracle_show_coupling finds billing-payments coupling", async () => {
    const result = await client.callTool({
      name: "git_oracle_show_coupling",
      arguments: { module: "src/billing", min_co_changes: 1 },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("src/payments");
  });

  it("git_oracle_trace_decision traces gRPC migration", async () => {
    const result = await client.callTool({
      name: "git_oracle_trace_decision",
      arguments: { topic: "gRPC migration" },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text.length).toBeGreaterThan(0);
  });

  it("git_oracle_get_path finds path between Alice and gRPC", async () => {
    const result = await client.callTool({
      name: "git_oracle_get_path",
      arguments: { from: "person:alice-chen", to: "technology:grpc" },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("Alice Chen");
    expect(text).toContain("gRPC");
  });

  it("git_oracle_get_path returns not-found for missing entity", async () => {
    const result = await client.callTool({
      name: "git_oracle_get_path",
      arguments: { from: "person:nobody", to: "technology:grpc" },
    });

    expect(result.isError).toBeTruthy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("not found");
  });

  it("git_oracle_get_entity looks up Alice by name", async () => {
    const result = await client.callTool({
      name: "git_oracle_get_entity",
      arguments: { query: "Alice Chen" },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("Alice Chen");
    expect(text).toContain("PERSON");
    expect(text).toContain("Relationships");
  });

  it("git_oracle_get_entity returns not-found message", async () => {
    const result = await client.callTool({
      name: "git_oracle_get_entity",
      arguments: { query: "zzz-nonexistent-xyz" },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("No entity found");
  });

  it("git_oracle_find_silos identifies knowledge risks", async () => {
    const result = await client.callTool({
      name: "git_oracle_find_silos",
      arguments: { min_frequency: 1, inactive_days: 100_000 },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    // billing (only Bob) and middleware (only Alice) are silos
    expect(text).toContain("Knowledge");
    expect(text).toContain("src/billing");
  });

  it("lists MCP resources", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);

    expect(uris).toContain("git-oracle://stats");
    expect(uris).toContain("git-oracle://graph/summary");
  });

  it("reads stats resource", async () => {
    const result = await client.readResource({ uri: "git-oracle://stats" });
    const text = (result.contents[0] as { text: string }).text;
    const data = JSON.parse(text);

    expect(data.entities).toBeGreaterThan(0);
    expect(data.relations).toBeGreaterThan(0);
    expect(data.lastIndexedCommit).toBe("bbb222");
  });

  it("reads graph summary resource", async () => {
    const result = await client.readResource({
      uri: "git-oracle://graph/summary",
    });
    const text = (result.contents[0] as { text: string }).text;

    expect(text).toContain("Knowledge Graph Summary");
    expect(text).toContain("Entities:");
  });
});
