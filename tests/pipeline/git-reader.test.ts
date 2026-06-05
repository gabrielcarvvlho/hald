import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { simpleGit } from "simple-git";
import { createSampleRepo } from "../helpers/sample-repo.js";
import { readCommits, getHead, getFileTree } from "../../src/pipeline/git-reader.js";

describe("git-reader", () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = mkdtempSync(join(tmpdir(), "hald-test-"));
    await createSampleRepo(repoDir);
  }, 30_000);

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("reads all commits in chronological order", async () => {
    const commits = [];
    for await (const commit of readCommits({ repoPath: repoDir })) {
      commits.push(commit);
    }

    expect(commits.length).toBe(10);
    // First commit should be the initial setup
    expect(commits[0]!.message).toContain("initial project setup");
    // Last commit should be the test addition
    expect(commits[9]!.message).toContain("test suites");
  });

  it("captures author information correctly", async () => {
    const commits = [];
    for await (const c of readCommits({ repoPath: repoDir })) {
      commits.push(c);
    }

    // First commit is Alice
    expect(commits[0]!.authorName).toBe("Alice Chen");
    expect(commits[0]!.authorEmail).toBe("alice@acme.com");

    // Third commit is Bob
    expect(commits[2]!.authorName).toBe("Bob Martinez");
    expect(commits[2]!.authorEmail).toBe("bob@acme.com");
  });

  it("captures file changes with status", async () => {
    const commits = [];
    for await (const c of readCommits({ repoPath: repoDir })) {
      commits.push(c);
    }

    // First commit: all files are added
    const firstFiles = commits[0]!.filesChanged;
    expect(firstFiles.length).toBeGreaterThan(0);
    expect(firstFiles.every((f) => f.status === "added")).toBe(true);
  });

  it("captures numstat (additions/deletions)", async () => {
    const commits = [];
    for await (const c of readCommits({ repoPath: repoDir })) {
      commits.push(c);
    }

    // At least some files should have non-zero additions
    const allFiles = commits.flatMap((c) => c.filesChanged);
    const withAdditions = allFiles.filter((f) => f.additions > 0);
    expect(withAdditions.length).toBeGreaterThan(0);
  });

  it("respects maxCommits option", async () => {
    const commits = [];
    for await (const c of readCommits({ repoPath: repoDir, maxCommits: 3 })) {
      commits.push(c);
    }
    expect(commits.length).toBe(3);
  });

  it("respects sinceDate option", async () => {
    // Use a future date — should return 0 commits
    const commits = [];
    for await (const c of readCommits({
      repoPath: repoDir,
      sinceDate: "2099-01-01",
    })) {
      commits.push(c);
    }
    expect(commits.length).toBe(0);
  });

  it("getHead returns a commit hash", async () => {
    const head = await getHead(repoDir);
    expect(head).toMatch(/^[a-f0-9]{40}$/);
  });

  it("getFileTree returns file paths", async () => {
    const tree = await getFileTree(repoDir);
    expect(tree).toContain("package.json");
    expect(tree).toContain("src/index.ts");
    expect(tree).toContain("src/billing/processor.ts");
  });
});

describe("git-reader — empty repo", () => {
  let emptyDir: string;

  beforeAll(async () => {
    // A freshly-init'd repo with zero commits: `git log` fatals here, which
    // used to crash the whole scan. readCommits must degrade to zero commits.
    emptyDir = mkdtempSync(join(tmpdir(), "hald-empty-"));
    const git = simpleGit(emptyDir);
    await git.init();
    await git.addConfig("user.name", "Nobody");
    await git.addConfig("user.email", "nobody@example.com");
  }, 30_000);

  afterAll(() => {
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("yields zero commits instead of throwing", async () => {
    const commits = [];
    for await (const commit of readCommits({ repoPath: emptyDir })) {
      commits.push(commit);
    }
    expect(commits.length).toBe(0);
  });
});
