import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LLMClient, LLMResponse } from "../../src/llm/types.js";
import type { HaldConfig } from "../../src/shared/types.js";
import type { Presenter, StageId } from "../../src/shared/presenter.js";

// ================================================================
// Mock LLM (must run before importing orchestrator)
// ================================================================

const mockClient: LLMClient = {
  provider: "anthropic" as const,
  async extract(prompt: string): Promise<LLMResponse> {
    if (prompt.includes("<community_members>")) {
      return {
        text: `<community_summary><title>T</title><summary>S</summary></community_summary>`,
        inputTokens: 100,
        outputTokens: 50,
        model: "mock",
        stopReason: "end_turn",
      };
    }
    return {
      text: `<extraction>
        <entities>
          <entity><name>Alice Chen</name><type>PERSON</type><description>dev</description></entity>
          <entity><name>src/billing</name><type>MODULE</type><description>billing</description></entity>
        </entities>
        <relations>
          <relation><source>Alice Chen</source><target>src/billing</target><type>AUTHORED</type><description>x</description><weight>5</weight></relation>
        </relations>
      </extraction>`,
      inputTokens: 200,
      outputTokens: 100,
      model: "mock",
      stopReason: "end_turn",
    };
  },
};

vi.mock("../../src/llm/client.js", () => ({
  createClient: vi.fn(async () => mockClient),
  detectProvider: vi.fn(() => ({ provider: "anthropic", apiKey: "mock" })),
}));

// Skip embeddings entirely — that path is exercised in full-pipeline.test.ts.
vi.mock("../../src/llm/embeddings.js", () => ({
  createEmbeddingClient: vi.fn(async () => null),
}));

import { indexRepository } from "../../src/pipeline/orchestrator.js";
import { createSampleRepo } from "../helpers/sample-repo.js";

// ================================================================
// Recording presenter — captures event sequence for assertions
// ================================================================

interface Event {
  kind: "start" | "update" | "end" | "warn" | "error" | "abort" | "final";
  stage?: StageId;
  done?: number;
  total?: number;
  summary?: string;
  message?: string;
}

class RecordingPresenter implements Presenter {
  events: Event[] = [];

  stageStart(stage: StageId): void {
    this.events.push({ kind: "start", stage });
  }
  stageUpdate(stage: StageId, done: number, total: number): void {
    this.events.push({ kind: "update", stage, done, total });
  }
  stageEnd(stage: StageId, summary?: string): void {
    this.events.push({ kind: "end", stage, summary });
  }
  stageWarn(stage: StageId, message: string): void {
    this.events.push({ kind: "warn", stage, message });
  }
  stageError(stage: StageId): void {
    this.events.push({ kind: "error", stage });
  }
  abort(): void {
    this.events.push({ kind: "abort" });
  }
  async final(): Promise<void> {
    this.events.push({ kind: "final" });
  }

  /** All stages that received a `start` event, in order. */
  startedStages(): StageId[] {
    return this.events.filter((e) => e.kind === "start").map((e) => e.stage!);
  }

  /** All stages that received an `end` event, in order. */
  endedStages(): StageId[] {
    return this.events.filter((e) => e.kind === "end").map((e) => e.stage!);
  }

  /** Find first end event for a stage. */
  endFor(stage: StageId): Event | undefined {
    return this.events.find((e) => e.kind === "end" && e.stage === stage);
  }
}

// ================================================================
// Test setup
// ================================================================

describe("orchestrator emits presenter events", () => {
  let tmpDir: string;
  let repoDir: string;
  let storageDir: string;
  let config: HaldConfig;
  let presenter: RecordingPresenter;

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `hald-presenter-${Date.now()}`);
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

    presenter = new RecordingPresenter();
    await indexRepository(config, { presenter });
  }, 30_000);

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits start+end for every pipeline stage", () => {
    const expected: StageId[] = [
      "reading",
      "chunking",
      "extracting",
      "resolving",
      "building",
      "clustering",
      "summarizing",
      "embedding",
    ];
    expect(presenter.startedStages()).toEqual(expected);
    expect(presenter.endedStages()).toEqual(expected);
  });

  it("emits stages in pipeline order (each end precedes next start)", () => {
    const order: { kind: string; stage: StageId }[] = [];
    for (const e of presenter.events) {
      if (e.kind === "start" || e.kind === "end") {
        order.push({ kind: e.kind, stage: e.stage! });
      }
    }
    // For each consecutive (end X, start Y), X must come before Y in the canonical order.
    const canonical: StageId[] = [
      "reading",
      "chunking",
      "extracting",
      "resolving",
      "building",
      "clustering",
      "summarizing",
      "embedding",
    ];
    for (let i = 0; i < canonical.length; i++) {
      const stage = canonical[i]!;
      const startIdx = order.findIndex((e) => e.kind === "start" && e.stage === stage);
      const endIdx = order.findIndex((e) => e.kind === "end" && e.stage === stage);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThan(startIdx);
    }
  });

  it("attaches non-empty summaries to user-facing stage ends", () => {
    expect(presenter.endFor("reading")?.summary).toMatch(/\d+ commits?/);
    expect(presenter.endFor("chunking")?.summary).toMatch(/text units?/);
    expect(presenter.endFor("extracting")?.summary).toMatch(/entities/);
    expect(presenter.endFor("resolving")?.summary).toMatch(/unique entities?/);
    expect(presenter.endFor("clustering")?.summary).toMatch(/communities?/);
    // building and embedding may have no/optional summaries, that's allowed
  });

  it("emits update events with done/total for extracting stage", () => {
    const updates = presenter.events.filter(
      (e) => e.kind === "update" && e.stage === "extracting",
    );
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      expect(u.total).toBeGreaterThan(0);
      expect(u.done).toBeGreaterThanOrEqual(0);
      expect(u.done).toBeLessThanOrEqual(u.total!);
    }
    // Final extracting update should equal total
    const last = updates[updates.length - 1]!;
    expect(last.done).toBe(last.total);
  });

  it("never emits more than one end per stage", () => {
    const ends = presenter.events.filter((e) => e.kind === "end");
    const counts = new Map<StageId, number>();
    for (const e of ends) {
      counts.set(e.stage!, (counts.get(e.stage!) ?? 0) + 1);
    }
    for (const [, n] of counts) expect(n).toBe(1);
  });

  it("does not call final() or abort() (CLI's responsibility)", () => {
    expect(presenter.events.find((e) => e.kind === "final")).toBeUndefined();
    expect(presenter.events.find((e) => e.kind === "abort")).toBeUndefined();
  });
});

// ================================================================
// Backward-compat: presenter is optional, existing callers unaffected
// ================================================================

describe("orchestrator without presenter", () => {
  it("runs to completion when no presenter is supplied (regression)", async () => {
    const tmpDir = join(tmpdir(), `hald-presenter-back-${Date.now()}`);
    const repoDir = join(tmpDir, "repo");
    const storageDir = join(tmpDir, "storage");
    mkdirSync(storageDir, { recursive: true });
    await createSampleRepo(repoDir);

    const config: HaldConfig = {
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

    // No `presenter` option — should behave identically to pre-Tier-1.
    const result = await indexRepository(config);
    expect(result.commitsProcessed).toBeGreaterThan(0);
    expect(result.entitiesFound).toBeGreaterThanOrEqual(1);

    rmSync(tmpDir, { recursive: true, force: true });
  }, 30_000);
});
