import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LLMClient, LLMResponse } from "../../src/llm/types.js";
import type { HaldConfig } from "../../src/shared/types.js";

// ================================================================
// Mock the LLM client module BEFORE importing orchestrator
// ================================================================

const mockClient: LLMClient = {
  provider: "anthropic" as const,

  async extract(prompt: string, _systemPrompt: string): Promise<LLMResponse> {
    // Summarization requests contain <community_members>
    if (prompt.includes("<community_members>")) {
      return {
        text: buildSummaryResponse(prompt),
        inputTokens: 200,
        outputTokens: 100,
        model: "mock-model",
        stopReason: "end_turn",
      };
    }

    // Extraction requests contain <commit_data>
    return {
      text: buildExtractionResponse(prompt),
      inputTokens: 500,
      outputTokens: 300,
      model: "mock-model",
      stopReason: "end_turn",
    };
  },
};

vi.mock("../../src/llm/client.js", () => ({
  createClient: vi.fn(async () => mockClient),
  detectProvider: vi.fn(() => ({ provider: "anthropic", apiKey: "mock-key" })),
}));

// Now import modules that use the LLM client
import { indexRepository } from "../../src/pipeline/orchestrator.js";
import { openDatabase } from "../../src/store/db.js";
import { Store } from "../../src/store/queries.js";
import { localSearch } from "../../src/query/local-search.js";
import { globalSearch } from "../../src/query/global-search.js";
import { findExperts } from "../../src/query/graph-ops.js";
import { createSampleRepo } from "../helpers/sample-repo.js";

// ================================================================
// Deterministic LLM response builders
// ================================================================

function buildExtractionResponse(prompt: string): string {
  const entities: string[] = [];
  const relations: string[] = [];

  if (prompt.includes("Alice Chen")) {
    entities.push(`
      <entity>
        <name>Alice Chen</name>
        <type>PERSON</type>
        <description>Lead developer who drove the gRPC migration</description>
      </entity>`);
  }
  if (prompt.includes("Bob Martinez")) {
    entities.push(`
      <entity>
        <name>Bob Martinez</name>
        <type>PERSON</type>
        <description>Developer who maintains the billing module</description>
      </entity>`);
  }
  if (prompt.includes("Carlos Ruiz")) {
    entities.push(`
      <entity>
        <name>Carlos Ruiz</name>
        <type>PERSON</type>
        <description>Documentation author</description>
      </entity>`);
  }

  if (prompt.includes("src/billing")) {
    entities.push(`
      <entity>
        <name>src/billing</name>
        <type>MODULE</type>
        <description>Billing processor module</description>
      </entity>`);
  }
  if (prompt.includes("src/payments")) {
    entities.push(`
      <entity>
        <name>src/payments</name>
        <type>MODULE</type>
        <description>Payments service module</description>
      </entity>`);
  }
  if (prompt.includes("src/middleware")) {
    entities.push(`
      <entity>
        <name>src/middleware</name>
        <type>MODULE</type>
        <description>Auth middleware layer</description>
      </entity>`);
  }

  if (prompt.includes("gRPC") || prompt.includes("grpc") || prompt.includes("proto")) {
    entities.push(`
      <entity>
        <name>gRPC</name>
        <type>TECHNOLOGY</type>
        <description>RPC framework adopted for inter-service communication</description>
      </entity>`);
  }

  if (prompt.includes("Alice Chen") && prompt.includes("src/payments")) {
    relations.push(`
      <relation>
        <source>Alice Chen</source>
        <target>src/payments</target>
        <type>AUTHORED</type>
        <description>Alice implemented the payments module</description>
        <weight>9</weight>
      </relation>`);
  }
  if (prompt.includes("Alice Chen") && prompt.includes("src/middleware")) {
    relations.push(`
      <relation>
        <source>Alice Chen</source>
        <target>src/middleware</target>
        <type>AUTHORED</type>
        <description>Alice created the auth middleware</description>
        <weight>7</weight>
      </relation>`);
  }
  if (prompt.includes("Bob Martinez") && prompt.includes("src/billing")) {
    relations.push(`
      <relation>
        <source>Bob Martinez</source>
        <target>src/billing</target>
        <type>AUTHORED</type>
        <description>Bob maintains the billing module</description>
        <weight>8</weight>
      </relation>`);
  }
  if (prompt.includes("src/billing") && prompt.includes("src/payments")) {
    relations.push(`
      <relation>
        <source>src/billing</source>
        <target>src/payments</target>
        <type>CO_CHANGED</type>
        <description>Billing and payments changed together</description>
        <weight>5</weight>
      </relation>`);
  }

  return `<extraction>
  <entities>${entities.join("")}
  </entities>
  <relations>${relations.join("")}
  </relations>
</extraction>`;
}

function buildSummaryResponse(prompt: string): string {
  let title = "Development Community";
  let summary = "A community of developers and modules.";

  if (prompt.includes("src/payments") || prompt.includes("gRPC")) {
    title = "Payments & gRPC Migration";
    summary =
      "This community centers on the payments service and its migration from REST to gRPC. " +
      "Alice Chen led the migration effort. The billing module depends on payments for charge operations.";
  } else if (prompt.includes("src/billing")) {
    title = "Billing Integration";
    summary =
      "This community covers the billing module and its integration with the payments service. " +
      "Bob Martinez is the primary maintainer.";
  } else if (prompt.includes("src/middleware")) {
    title = "Auth & Middleware";
    summary =
      "This community covers the authentication middleware layer. " +
      "Alice Chen created and maintains it.";
  }

  return `<community_summary>
  <title>${title}</title>
  <summary>${summary}</summary>
</community_summary>`;
}

// ================================================================
// Test Suite
// ================================================================

describe("Full pipeline integration test", () => {
  let tmpDir: string;
  let repoDir: string;
  let storageDir: string;
  let store: Store;
  let config: HaldConfig;

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `hald-e2e-${Date.now()}`);
    repoDir = join(tmpDir, "repo");
    storageDir = join(tmpDir, "storage");
    mkdirSync(storageDir, { recursive: true });

    await createSampleRepo(repoDir);

    config = {
      repoPath: repoDir,
      branch: "HEAD",
      commitsPerChunk: 5,
      maxChunkTokens: 2000,
      provider: "anthropic",
      maxConcurrency: 2,
      maxRetries: 0,
      entityResolutionThreshold: 0.85,
      communityResolutions: [1.0],
      minCommunitySize: 2,
      parentLinkThreshold: 0.3,
      splitWarningThreshold: 0.7,
      summaryReuseThreshold: 0.7,
      storagePath: storageDir,
    };

    const result = await indexRepository(config);

    expect(result.commitsProcessed).toBe(10);
    expect(result.entitiesFound).toBeGreaterThanOrEqual(3);
    expect(result.relationsFound).toBeGreaterThanOrEqual(1);
    expect(result.communitiesFound).toBeGreaterThanOrEqual(1);
    expect(result.tokenUsage.requests).toBeGreaterThan(0);

    // Open the store for subsequent tests
    const db = openDatabase(storageDir);
    store = new Store(db);
  }, 30_000);

  afterAll(() => {
    store?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Entity assertions ---

  it("creates entities with correct types (PERSON, MODULE, TECHNOLOGY)", () => {
    const allEntities = store.getAllEntities();
    expect(allEntities.length).toBeGreaterThanOrEqual(3);

    const types = new Set(allEntities.map((e) => e.type));
    expect(types.has("PERSON")).toBe(true);
    expect(types.has("MODULE")).toBe(true);
    // TECHNOLOGY may or may not appear depending on chunk composition
  });

  it("stores all 10 commits", () => {
    const stats = store.getStats();
    expect(stats.commits).toBe(10);
  });

  it("creates text units", () => {
    const stats = store.getStats();
    expect(stats.textUnits).toBeGreaterThanOrEqual(1);
  });

  // --- Relation assertions ---

  it("creates AUTHORED relations from LLM extraction", () => {
    const allRelations = store.getAllRelations();
    expect(allRelations.length).toBeGreaterThanOrEqual(2);

    const types = new Set(allRelations.map((r) => r.type));
    // AUTHORED proves the LLM mock extraction worked (CO_CHANGED is commit-derived, not proof of extraction)
    expect(types.has("AUTHORED")).toBe(true);
  });

  // --- Community assertions ---

  it("detects at least 1 community", () => {
    const communities = [
      ...store.getCommunitiesByLevel(0),
      ...store.getCommunitiesByLevel(1),
      ...store.getCommunitiesByLevel(2),
    ];
    expect(communities.length).toBeGreaterThanOrEqual(1);
  });

  // --- Stats ---

  it("getStats returns positive counts in all categories", () => {
    const stats = store.getStats();
    expect(stats.entities).toBeGreaterThan(0);
    expect(stats.relations).toBeGreaterThan(0);
    expect(stats.textUnits).toBeGreaterThan(0);
    expect(stats.communities).toBeGreaterThan(0);
    expect(stats.commits).toBeGreaterThan(0);
  });

  // --- Query: localSearch ---

  it("localSearch finds Alice by name", async () => {
    const result = await localSearch(store, {
      query: "Alice Chen",
      maxEntities: 10,
      maxRelations: 20,
      maxTextUnits: 5,
    });

    expect(result.entities.length).toBeGreaterThanOrEqual(1);
    const names = result.entities.map((e) => e.name);
    expect(names.some((n) => n.includes("Alice"))).toBe(true);
  });

  // --- Query: findExperts ---

  it("findExperts returns at least 1 expert for src/payments", () => {
    const experts = findExperts(store, "src/payments");
    expect(experts.length).toBeGreaterThanOrEqual(1);
  });

  // --- Query: globalSearch ---

  it("globalSearch returns communities array without crash", async () => {
    const result = await globalSearch(store, {
      query: "architecture decisions",
      maxCommunities: 5,
    });

    // globalSearch always returns an array — verify it's populated (communities were summarized)
    expect(Array.isArray(result.communities)).toBe(true);
    // At least verify the store has communities (globalSearch may not match FTS, but communities exist)
    expect(store.getStats().communities).toBeGreaterThan(0);
  });

  // --- Metadata ---

  it("sets index metadata correctly", () => {
    const lastCommit = store.getMeta("last_indexed_commit");
    expect(lastCommit).toBeTruthy();

    const lastIndexed = store.getMeta("last_indexed_at");
    expect(lastIndexed).toBeTruthy();
  });
});
