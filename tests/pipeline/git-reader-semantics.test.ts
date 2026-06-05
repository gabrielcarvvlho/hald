import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import simpleGit from "simple-git";
import { readCommits } from "../../src/pipeline/git-reader.js";
import type { CommitData } from "../../src/shared/types.js";

// ================================================================
// Helper: build a repo with N sequential commits
// ================================================================

async function createSequentialRepo(dir: string, count: number): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.name", "Seq Author");
  await git.addConfig("user.email", "seq@test.com");

  const messages: string[] = [];
  for (let i = 1; i <= count; i++) {
    writeFileSync(join(dir, "file.txt"), `version ${i}\n`);
    await git.add(".");
    const msg = `feat: change number ${i}`;
    await git.commit(msg);
    messages.push(msg);
  }
  return messages;
}

async function collect(opts: Parameters<typeof readCommits>[0]): Promise<CommitData[]> {
  const out: CommitData[] = [];
  for await (const c of readCommits(opts)) out.push(c);
  return out;
}

// ================================================================
// Task 5: __COMMIT__ delimiter collision
// ================================================================

describe("git-reader: record delimiter collision", () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = mkdtempSync(join(tmpdir(), "hald-delim-"));
    const git = simpleGit(repoDir);
    await git.init();
    await git.addConfig("user.name", "Delim Author");
    await git.addConfig("user.email", "delim@test.com");

    // First commit: a perfectly normal message.
    writeFileSync(join(repoDir, "a.txt"), "a\n");
    await git.add(".");
    await git.commit("chore: first normal commit");

    // Second commit: a message that literally contains the old "__COMMIT__"
    // record delimiter. With the old split-on-"__COMMIT__" parser this would
    // fracture the commit block and corrupt the parse.
    writeFileSync(join(repoDir, "b.txt"), "b\n");
    await git.add(".");
    await git.commit(
      "fix: handle __COMMIT__ token in body\n\nThe string __COMMIT__ appears mid-message and must not split records.",
    );

    // Third commit: another normal one so we can assert ordering/counts.
    writeFileSync(join(repoDir, "c.txt"), "c\n");
    await git.add(".");
    await git.commit("docs: third commit");
  }, 30_000);

  afterAll(() => rmSync(repoDir, { recursive: true, force: true }));

  it("does not split records on a '__COMMIT__' literal inside a commit message", async () => {
    const commits = await collect({ repoPath: repoDir });

    // Exactly 3 commits — a naive '__COMMIT__' split would yield 4 blocks.
    expect(commits.length).toBe(3);

    // The middle commit's message is preserved verbatim, '__COMMIT__' and all.
    expect(commits[1]!.message).toBe("fix: handle __COMMIT__ token in body");

    // The collision must not bleed file changes across commits: each commit
    // here adds exactly one file.
    expect(commits[0]!.filesChanged.map((f) => f.path)).toEqual(["a.txt"]);
    expect(commits[1]!.filesChanged.map((f) => f.path)).toEqual(["b.txt"]);
    expect(commits[2]!.filesChanged.map((f) => f.path)).toEqual(["c.txt"]);

    // And the author header is parsed cleanly (not contaminated by the literal).
    expect(commits[1]!.authorName).toBe("Delim Author");
    expect(commits[1]!.authorEmail).toBe("delim@test.com");
  });
});

// ================================================================
// Task 4: --max-commits selects the OLDEST N + backfills
// ================================================================

describe("git-reader: maxCommits oldest-N semantics", () => {
  let repoDir: string;
  let messages: string[];

  beforeAll(async () => {
    repoDir = mkdtempSync(join(tmpdir(), "hald-maxc-"));
    messages = await createSequentialRepo(repoDir, 6);
  }, 30_000);

  afterAll(() => rmSync(repoDir, { recursive: true, force: true }));

  it("returns the OLDEST N commits (not the newest N) in chronological order", async () => {
    const commits = await collect({ repoPath: repoDir, maxCommits: 3 });

    expect(commits.length).toBe(3);
    // Oldest three, in order: changes 1, 2, 3 — NOT the newest three (4, 5, 6).
    expect(commits.map((c) => c.message)).toEqual([messages[0], messages[1], messages[2]]);
  });

  it("a subsequent scan from the checkpoint backfills the remaining commits", async () => {
    // First batch: oldest 3.
    const firstBatch = await collect({ repoPath: repoDir, maxCommits: 3 });
    expect(firstBatch.map((c) => c.message)).toEqual([messages[0], messages[1], messages[2]]);

    // The orchestrator advances last_indexed_commit to the newest processed
    // commit, then the next scan runs `<checkpoint>..HEAD`. Emulate that here.
    const checkpoint = firstBatch[firstBatch.length - 1]!.hash;

    const secondBatch = await collect({
      repoPath: repoDir,
      sinceCommit: checkpoint,
      maxCommits: 3,
    });

    // Backfills the remaining 3 (changes 4, 5, 6) — none skipped.
    expect(secondBatch.map((c) => c.message)).toEqual([messages[3], messages[4], messages[5]]);

    // Union of both batches covers the whole history with no overlap/gap.
    const seen = [...firstBatch, ...secondBatch].map((c) => c.message);
    expect(seen).toEqual(messages);
  });

  it("without maxCommits, reads the full history oldest-first", async () => {
    const commits = await collect({ repoPath: repoDir });
    expect(commits.map((c) => c.message)).toEqual(messages);
  });
});
