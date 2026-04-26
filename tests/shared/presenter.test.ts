import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  JsonPresenter,
  PrettyPresenter,
  selectPresenter,
} from "../../src/shared/presenter.js";
import type { IndexResult } from "../../src/pipeline/orchestrator.js";

// ================================================================
// Fixtures
// ================================================================

function makeResult(over: Partial<IndexResult> = {}): IndexResult {
  return {
    commitsProcessed: 1247,
    entitiesFound: 312,
    relationsFound: 891,
    communitiesFound: 14,
    communitiesSummarized: 8,
    tokenUsage: { inputTokens: 12345, outputTokens: 6789, requests: 25, failures: 1 },
    actualCostUsd: 0.4231,
    ...over,
  };
}

// ================================================================
// JsonPresenter — preserves legacy non-TTY output
// ================================================================

describe("JsonPresenter", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("stage events are no-ops (no stdout/stderr writes)", () => {
    const p = new JsonPresenter();
    p.stageStart("reading", "label");
    p.stageUpdate("extracting", 5, 100, "note");
    p.stageEnd("clustering", "14 communities");
    p.stageWarn("extracting", "1 chunk failed");
    p.stageError("summarizing", new Error("boom"));
    p.abort(new Error("done"));
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("final() prints summary lines to stdout (legacy format)", async () => {
    const p = new JsonPresenter();
    await p.final(makeResult(), 5000);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const out = String(stdoutSpy.mock.calls[0]![0]);
    expect(out).toContain("Done!");
    expect(out).toContain("Commits processed:       1247");
    expect(out).toContain("Entities:                312");
    expect(out).toContain("Relations:               891");
    expect(out).toContain("Communities:             14");
    expect(out).toContain("Communities summarized:  8");
    expect(out).toContain("LLM requests:            25 (1 failed)");
    expect(out).toContain("Tokens:");
    expect(out).toContain("12,345 in / 6,789 out");
    expect(out).toContain("Cost:                    $0.4231");
    // Trailing newline preserves legacy spacing
    expect(out.endsWith("\n\n")).toBe(true);
  });

  it("final() omits LLM lines when no requests were made (matches legacy)", async () => {
    const p = new JsonPresenter();
    await p.final(
      makeResult({
        tokenUsage: { inputTokens: 0, outputTokens: 0, requests: 0, failures: 0 },
        actualCostUsd: 0,
      }),
      100,
    );
    const out = String(stdoutSpy.mock.calls[0]![0]);
    expect(out).toContain("Done!");
    expect(out).not.toContain("LLM requests");
    expect(out).not.toContain("Cost:");
  });

  it("never writes to stderr (logger owns stderr)", async () => {
    const p = new JsonPresenter();
    await p.final(makeResult(), 1000);
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

// ================================================================
// selectPresenter — TTY detection (regression-critical)
// ================================================================

describe("selectPresenter", () => {
  it("non-TTY → JsonPresenter [REGRESSION]", () => {
    const p = selectPresenter({ env: {}, stream: { isTTY: false } });
    expect(p).toBeInstanceOf(JsonPresenter);
  });

  it("undefined isTTY → JsonPresenter [REGRESSION]", () => {
    const p = selectPresenter({ env: {}, stream: {} });
    expect(p).toBeInstanceOf(JsonPresenter);
  });

  it("TTY + HALD_JSON_LOGS=1 → JsonPresenter [REGRESSION]", () => {
    const p = selectPresenter({ env: { HALD_JSON_LOGS: "1" }, stream: { isTTY: true } });
    expect(p).toBeInstanceOf(JsonPresenter);
  });

  it("TTY + CI=true → JsonPresenter [REGRESSION]", () => {
    const p = selectPresenter({ env: { CI: "true" }, stream: { isTTY: true } });
    expect(p).toBeInstanceOf(JsonPresenter);
  });

  it("TTY + CI=1 → JsonPresenter (GitHub Actions style) [REGRESSION]", () => {
    const p = selectPresenter({ env: { CI: "1" }, stream: { isTTY: true } });
    expect(p).toBeInstanceOf(JsonPresenter);
  });

  it("TTY + clean env → PrettyPresenter", async () => {
    const p = selectPresenter({ env: {}, stream: { isTTY: true } });
    expect(p).toBeInstanceOf(PrettyPresenter);
    // Clean up the listr2 task graph that the constructor kicked off.
    p.abort(new Error("test cleanup"));
    await p.final(makeResult(), 0).catch(() => {
      /* ignored — final() may surface the abort via stderr write that we're mocking */
    });
  });

  it("HALD_JSON_LOGS empty string is falsy → PrettyPresenter (when TTY)", async () => {
    const p = selectPresenter({ env: { HALD_JSON_LOGS: "" }, stream: { isTTY: true } });
    expect(p).toBeInstanceOf(PrettyPresenter);
    p.abort(new Error("test cleanup"));
    await p.final(makeResult(), 0).catch(() => {});
  });
});

// ================================================================
// PrettyPresenter — lifecycle + abort
// ================================================================

describe("PrettyPresenter", () => {
  it("completes when all stages end in order", async () => {
    const p = new PrettyPresenter({ renderer: "silent" });
    p.stageStart("reading");
    p.stageUpdate("reading", 0, 0);
    p.stageEnd("reading", "10 commits");
    p.stageEnd("chunking", "5 text units");
    p.stageStart("extracting");
    p.stageUpdate("extracting", 1, 5);
    p.stageUpdate("extracting", 5, 5);
    p.stageEnd("extracting", "20 entities, 30 relations");
    p.stageEnd("resolving", "18 unique");
    p.stageEnd("building");
    p.stageEnd("clustering", "3 communities");
    p.stageEnd("summarizing", "3 new, 0 reused");
    p.stageEnd("embedding", "skipped (no embedding provider)");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await p.final(
        {
          commitsProcessed: 10,
          entitiesFound: 20,
          relationsFound: 30,
          communitiesFound: 3,
          communitiesSummarized: 3,
          tokenUsage: { inputTokens: 0, outputTokens: 0, requests: 0, failures: 0 },
          actualCostUsd: 0,
        },
        1234,
      );
      // Summary card written to stderr in pretty mode
      expect(stderrSpy).toHaveBeenCalled();
      const allOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(allOutput).toContain("Scan complete");
      expect(allOutput).toContain("Commits processed");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("abort() unblocks final() even if stages never end", async () => {
    const p = new PrettyPresenter({ renderer: "silent" });
    p.stageStart("reading");
    p.abort(new Error("user cancelled"));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // final should still resolve (listrPromise.catch swallows the rejection)
      await p.final(
        {
          commitsProcessed: 0,
          entitiesFound: 0,
          relationsFound: 0,
          communitiesFound: 0,
          communitiesSummarized: 0,
          tokenUsage: { inputTokens: 0, outputTokens: 0, requests: 0, failures: 0 },
          actualCostUsd: 0,
        },
        100,
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("stageError(...) does not prevent final() from resolving", async () => {
    const p = new PrettyPresenter({ renderer: "silent" });
    p.stageStart("reading");
    p.stageError("reading", new Error("git failed"));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // Listr will short-circuit on first error; final() awaits then prints summary card.
      // CLI never calls final() in error path, but presenter must not deadlock if it does.
      // Use a timeout to prove it resolves promptly.
      const result = await Promise.race([
        p.final(
          {
            commitsProcessed: 0,
            entitiesFound: 0,
            relationsFound: 0,
            communitiesFound: 0,
            communitiesSummarized: 0,
            tokenUsage: { inputTokens: 0, outputTokens: 0, requests: 0, failures: 0 },
            actualCostUsd: 0,
          },
          50,
        ),
        new Promise((_, rej) => setTimeout(() => rej(new Error("deadlock")), 2000)),
      ]);
      expect(result).toBeUndefined();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
