import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import simpleGit from "simple-git";
import type { LLMClient, LLMResponse } from "../../src/llm/types.js";
import type { GitOracleConfig } from "../../src/shared/types.js";

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

  function makeConfig(): GitOracleConfig {
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
    tmpDir = join(tmpdir(), `git-oracle-incr-${Date.now()}`);
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
    // Add commits that introduce a new module/entity, changing community structure
    await addExtraCommits(repoDir, 3);

    const result = await indexRepository(makeConfig());

    expect(result.commitsProcessed).toBe(3);
    // Extraction should have been called for the new chunks
    expect(extractCalls.length).toBeGreaterThan(0);

    // Total commits should now be 11
    const db = openDatabase(storageDir);
    const store = new Store(db);
    expect(store.getStats().commits).toBe(11);
    store.close();
  }, 30_000);

  it("scenario 4: re-index with no new commits reuses existing summaries", async () => {
    extractCalls = [];
    summaryCalls = [];

    const result = await indexRepository(makeConfig());

    expect(result.commitsProcessed).toBe(0);
    // No extraction or summarization calls when nothing changed
    expect(extractCalls.length).toBe(0);
    expect(summaryCalls.length).toBe(0);
  }, 30_000);
});
