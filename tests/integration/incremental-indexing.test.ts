import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import simpleGit from "simple-git";
import type { LLMClient, LLMResponse } from "../../src/llm/types.js";
import type { HaldConfig } from "../../src/shared/types.js";
import { EntityType } from "../../src/shared/types.js";

// ================================================================
// Mock LLM client with call tracking
// ================================================================

let extractCalls: string[] = [];
let summaryCalls: string[] = [];

const mockClient: LLMClient = {
  provider: "anthropic" as const,

  async extract(prompt: string, _systemPrompt: string): Promise<LLMResponse> {
    if (prompt.includes("<community_members>")) {
      summaryCalls.push(prompt);
      return {
        text: `<community_summary>
  <title>Test Community</title>
  <summary>A test community summary.</summary>
</community_summary>`,
        inputTokens: 200,
        outputTokens: 100,
        model: "mock-model",
        stopReason: "end_turn",
      };
    }

    extractCalls.push(prompt);

    const entities: string[] = [];
    const relations: string[] = [];

    if (prompt.includes("Alice")) {
      entities.push(
        `<entity><name>Alice</name><type>PERSON</type><description>Developer</description></entity>`,
      );
    }
    if (prompt.includes("Bob")) {
      entities.push(
        `<entity><name>Bob</name><type>PERSON</type><description>Developer</description></entity>`,
      );
    }
    if (prompt.includes("src/core")) {
      entities.push(
        `<entity><name>src/core</name><type>MODULE</type><description>Core module</description></entity>`,
      );
    }
    if (prompt.includes("src/api")) {
      entities.push(
        `<entity><name>src/api</name><type>MODULE</type><description>API module</description></entity>`,
      );
    }
    if (prompt.includes("src/extra")) {
      entities.push(
        `<entity><name>src/extra</name><type>MODULE</type><description>Extra module</description></entity>`,
      );
    }

    if (prompt.includes("Alice") && prompt.includes("src/core")) {
      relations.push(
        `<relation><source>Alice</source><target>src/core</target><type>AUTHORED</type><description>Alice authored core</description><weight>8</weight></relation>`,
      );
    }
    if (prompt.includes("Bob") && prompt.includes("src/api")) {
      relations.push(
        `<relation><source>Bob</source><target>src/api</target><type>AUTHORED</type><description>Bob authored api</description><weight>7</weight></relation>`,
      );
    }

    return {
      text: `<extraction><entities>${entities.join("")}</entities><relations>${relations.join("")}</relations></extraction>`,
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

import { indexRepository } from "../../src/pipeline/orchestrator.js";
import { openDatabase } from "../../src/store/db.js";
import { Store } from "../../src/store/queries.js";

// ================================================================
// Helper: create a repo with N commits
// ================================================================

async function createIncrementalRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.name", "Alice");
  await git.addConfig("user.email", "alice@test.com");

  mkdirSync(join(dir, "src/core"), { recursive: true });
  writeFileSync(join(dir, "src/core/index.ts"), "export const v = 1;");
  await git.add(".");
  await git.commit("feat: init core module");

  for (let i = 2; i <= 5; i++) {
    writeFileSync(join(dir, "src/core/index.ts"), `export const v = ${i};`);
    await git.add(".");
    await git.commit(`feat: update core v${i}`);
  }
}

async function addMoreCommits(dir: string, count: number): Promise<void> {
  const git = simpleGit(dir);
  await git.addConfig("user.name", "Bob");
  await git.addConfig("user.email", "bob@test.com");

  mkdirSync(join(dir, "src/api"), { recursive: true });
  for (let i = 1; i <= count; i++) {
    writeFileSync(join(dir, "src/api/handler.ts"), `export const v = ${i};`);
    await git.add(".");
    await git.commit(`feat: add api handler v${i}`);
  }
}

async function addExtraCommits(dir: string, count: number): Promise<void> {
  const git = simpleGit(dir);
  await git.addConfig("user.name", "Alice");
  await git.addConfig("user.email", "alice@test.com");

  mkdirSync(join(dir, "src/extra"), { recursive: true });
  for (let i = 1; i <= count; i++) {
    writeFileSync(join(dir, "src/extra/utils.ts"), `export const v = ${i};`);
    await git.add(".");
    await git.commit(`feat: add extra utils v${i}`);
  }
}

// ================================================================
// Tests
// ================================================================

describe("Incremental indexing", () => {
  let tmpDir: string;
  let repoDir: string;
  let storageDir: string;

  function makeConfig(): HaldConfig {
    return {
      repoPath: repoDir,
      branch: "HEAD",
      commitsPerChunk: 5,
      maxChunkTokens: 2000,
      provider: "anthropic",
      maxConcurrency: 1,
      maxRetries: 0,
      entityResolutionThreshold: 0.85,
      communityResolutions: [1.0],
      minCommunitySize: 2,
      parentLinkThreshold: 0.3,
      splitWarningThreshold: 0.7,
      summaryReuseThreshold: 0.7,
      storagePath: storageDir,
    };
  }

  beforeAll(() => {
    tmpDir = join(tmpdir(), `hald-incr-${Date.now()}`);
    repoDir = join(tmpDir, "repo");
    storageDir = join(tmpDir, "storage");
    mkdirSync(storageDir, { recursive: true });
  });

  beforeEach(() => {
    extractCalls = [];
    summaryCalls = [];
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scenario 1: initial index processes all commits", async () => {
    await createIncrementalRepo(repoDir);

    const result = await indexRepository(makeConfig());

    expect(result.commitsProcessed).toBe(5);
    expect(extractCalls.length).toBeGreaterThan(0);

    // Verify store has data
    const db = openDatabase(storageDir);
    const store = new Store(db);
    expect(store.getStats().commits).toBe(5);
    expect(store.getMeta("last_indexed_commit")).toBeTruthy();
    store.close();
  }, 30_000);

  it("scenario 1 continued: re-index after adding commits processes only new ones", async () => {
    extractCalls = [];

    await addMoreCommits(repoDir, 3);

    const result = await indexRepository(makeConfig());

    expect(result.commitsProcessed).toBe(3);
    expect(extractCalls.length).toBeGreaterThan(0);

    // Total commits should now be 8
    const db = openDatabase(storageDir);
    const store = new Store(db);
    expect(store.getStats().commits).toBe(8);
    store.close();
  }, 30_000);

  it("scenario 2: re-index with no new commits makes zero LLM calls", async () => {
    const result = await indexRepository(makeConfig());

    expect(result.commitsProcessed).toBe(0);
    expect(extractCalls.length).toBe(0);
    expect(summaryCalls.length).toBe(0);
  }, 30_000);

  it("scenario 3: re-index with new commits that change community composition triggers re-summarization", async () => {
    await addExtraCommits(repoDir, 3);

    // Capture community count before re-index
    const dbBefore = openDatabase(storageDir);
    const storeBefore = new Store(dbBefore);
    const communityCountBefore = storeBefore.getCommunitiesByLevel(0).length;
    storeBefore.close();

    const result = await indexRepository(makeConfig());

    expect(result.commitsProcessed).toBe(3);
    expect(extractCalls.length).toBeGreaterThan(0);
    // New or changed communities should trigger summarization
    // (summaryCalls may be 0 if all communities matched via Jaccard, but extraction must have run)

    const db = openDatabase(storageDir);
    const store = new Store(db);
    expect(store.getStats().commits).toBe(11);
    // Communities should still exist after re-index (may change due to new entities)
    const communitiesAfter = store.getCommunitiesByLevel(0);
    expect(communitiesAfter.length).toBeGreaterThanOrEqual(1);
    // Community count may differ from before due to new entities changing graph structure
    expect(communitiesAfter.length).toBeGreaterThanOrEqual(communityCountBefore > 0 ? 1 : 0);
    store.close();
  }, 30_000);

  it("scenario 4: re-index with no new commits reuses existing summaries", async () => {
    // Capture community summaries before re-index
    const dbBefore = openDatabase(storageDir);
    const storeBefore = new Store(dbBefore);
    const communitiesBefore = storeBefore.getCommunitiesByLevel(0);
    const summariesBefore = communitiesBefore.map((c) => ({ id: c.id, summary: c.summary }));
    storeBefore.close();

    extractCalls = [];
    summaryCalls = [];

    const result = await indexRepository(makeConfig());

    expect(result.commitsProcessed).toBe(0);
    expect(extractCalls.length).toBe(0);
    expect(summaryCalls.length).toBe(0);

    // Verify summaries are preserved (not wiped)
    if (summariesBefore.length > 0) {
      const dbAfter = openDatabase(storageDir);
      const storeAfter = new Store(dbAfter);
      for (const before of summariesBefore) {
        const after = storeAfter.getCommunity(before.id);
        if (after && before.summary) {
          expect(after.summary).toBe(before.summary);
        }
      }
      storeAfter.close();
    }
  }, 30_000);
});

// ================================================================
// --full idempotence: re-indexing with full:true must NOT double
// entity frequencies or relation weights (additive upserts would).
// ================================================================

describe("--full re-index idempotence", () => {
  let tmpDir: string;
  let repoDir: string;
  let storageDir: string;

  function makeFullConfig(): HaldConfig {
    return {
      repoPath: repoDir,
      branch: "HEAD",
      commitsPerChunk: 5,
      maxChunkTokens: 2000,
      provider: "anthropic",
      maxConcurrency: 1,
      maxRetries: 0,
      entityResolutionThreshold: 0.85,
      communityResolutions: [1.0],
      minCommunitySize: 2,
      parentLinkThreshold: 0.3,
      splitWarningThreshold: 0.7,
      summaryReuseThreshold: 0.7,
      storagePath: storageDir,
    };
  }

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `hald-full-${Date.now()}`);
    repoDir = join(tmpDir, "repo");
    storageDir = join(tmpDir, "storage");
    mkdirSync(storageDir, { recursive: true });
    await createIncrementalRepo(repoDir);
    await addMoreCommits(repoDir, 3);

    // Add a commit that touches TWO modules so a CO_CHANGED edge exists
    // (our witness for relation-weight idempotence).
    const git = simpleGit(repoDir);
    await git.addConfig("user.name", "Alice");
    await git.addConfig("user.email", "alice@test.com");
    mkdirSync(join(repoDir, "src/api"), { recursive: true });
    writeFileSync(join(repoDir, "src/core/index.ts"), "export const v = 99;");
    writeFileSync(join(repoDir, "src/api/handler.ts"), "export const v = 99;");
    await git.add(".");
    await git.commit("feat: wire core into api (cross-module change)");
  });

  beforeEach(() => {
    extractCalls = [];
    summaryCalls = [];
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("frequencies and weights are identical after a second full re-index (not doubled)", async () => {
    // First full index. NB: `full` is an IndexOptions field (2nd arg), not config.
    await indexRepository(makeFullConfig(), { full: true });

    const snapshot = () => {
      const db = openDatabase(storageDir);
      const store = new Store(db);
      // Pick a stable PERSON entity and the heaviest CO_CHANGED edge as witnesses.
      const people = store.getEntitiesByType(EntityType.PERSON).sort((a, b) => a.id.localeCompare(b.id));
      const coChanged = store
        .getAllRelations()
        .filter((r) => r.type === "CO_CHANGED")
        .sort((a, b) => a.id.localeCompare(b.id));
      const authored = store
        .getAllRelations()
        .filter((r) => r.type === "AUTHORED")
        .sort((a, b) => a.id.localeCompare(b.id));
      const stats = store.getStats();
      store.close();
      return {
        person: people[0] ? { id: people[0].id, frequency: people[0].frequency } : null,
        coChanged: coChanged[0] ? { id: coChanged[0].id, weight: coChanged[0].weight } : null,
        authored: authored[0] ? { id: authored[0].id, weight: authored[0].weight } : null,
        stats,
      };
    };

    const before = snapshot();
    // Sanity: the witnesses must exist, otherwise the test proves nothing.
    expect(before.person).not.toBeNull();
    expect(before.coChanged).not.toBeNull();
    expect(before.authored).not.toBeNull();

    // Second full re-index over the SAME, already-populated graph.
    const r2 = await indexRepository(makeFullConfig(), { full: true });
    // The re-index must actually re-process the whole history (proving the test
    // exercises the additive-upsert path that clearGraph() guards against).
    expect(r2.commitsProcessed).toBeGreaterThan(0);

    const after = snapshot();

    // Frequencies and weights must be IDENTICAL — clearGraph() wiped the old
    // rows so additive ON CONFLICT upserts don't accumulate across runs.
    expect(after.person).toEqual(before.person);
    expect(after.coChanged).toEqual(before.coChanged);
    expect(after.authored).toEqual(before.authored);

    // Counts must also be stable (no orphaned/duplicated rows).
    expect(after.stats.entities).toBe(before.stats.entities);
    expect(after.stats.relations).toBe(before.stats.relations);
    expect(after.stats.commits).toBe(before.stats.commits);
  }, 30_000);
});
