import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSampleRepo } from "../helpers/sample-repo.js";
import { readCommits } from "../../src/pipeline/git-reader.js";
import type { CommitData } from "../../src/shared/types.js";

describe("git-reader diffs", () => {
  let repoDir: string;
  let commits: CommitData[];

  beforeAll(async () => {
    repoDir = mkdtempSync(join(tmpdir(), "hald-diff-test-"));
    await createSampleRepo(repoDir);

    commits = [];
    for await (const commit of readCommits({ repoPath: repoDir })) {
      commits.push(commit);
    }
  }, 30_000);

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("populates diff for added files", () => {
    // Commit 1 (index 0) adds src/index.ts
    const firstCommit = commits[0]!;
    const indexFile = firstCommit.filesChanged.find((f) => f.path === "src/index.ts");
    expect(indexFile).toBeDefined();
    expect(indexFile!.diff).toBeDefined();
    expect(indexFile!.diff!.length).toBeGreaterThan(0);
    expect(indexFile!.diff).toContain("diff --git");
  });

  it("populates diff for modified files", () => {
    // Commit 4 (index 3) modifies src/billing/processor.ts
    const commit4 = commits[3]!;
    expect(commit4.message).toContain("integrate billing");
    const processorFile = commit4.filesChanged.find(
      (f) => f.path === "src/billing/processor.ts",
    );
    expect(processorFile).toBeDefined();
    expect(processorFile!.diff).toBeDefined();
    expect(processorFile!.diff!.length).toBeGreaterThan(0);
    expect(processorFile!.diff).toContain("diff --git");
  });

  it("non-merge commits have at least some diffs", () => {
    const nonMerge = commits.filter((c) => c.parentHashes.length <= 1);
    const withDiffs = nonMerge.filter((c) =>
      c.filesChanged.some((f) => f.diff !== undefined),
    );
    // All non-merge commits in the sample repo change code files, so all should have diffs
    expect(withDiffs.length).toBeGreaterThan(0);
    expect(withDiffs.length).toBe(nonMerge.length);
  });

  it("diff content contains actual code changes", () => {
    // Commit 4 integrates billing with payments — should see the import line
    const commit4 = commits[3]!;
    const processorFile = commit4.filesChanged.find(
      (f) => f.path === "src/billing/processor.ts",
    );
    expect(processorFile!.diff).toContain("handlePayment");
  });

  it("diff includes +/- lines for modifications", () => {
    // Commit 7 (index 6) updates billing for gRPC
    const commit7 = commits[6]!;
    expect(commit7.message).toContain("update billing");
    const processorFile = commit7.filesChanged.find(
      (f) => f.path === "src/billing/processor.ts",
    );
    expect(processorFile).toBeDefined();
    expect(processorFile!.diff).toBeDefined();
    // Modification diffs should contain both + and - lines
    expect(processorFile!.diff).toMatch(/^\+/m);
    expect(processorFile!.diff).toMatch(/^-/m);
  });
});
