import { describe, it, expect } from "vitest";
import { chunk, estimateTokens } from "../../src/pipeline/chunker.js";
import type { CommitData } from "../../src/shared/types.js";

function makeCommit(overrides: Partial<CommitData> = {}): CommitData {
  return {
    hash: "a".repeat(40),
    authorName: "Alice",
    authorEmail: "alice@co.com",
    date: "2024-03-01T10:00:00Z",
    message: "feat: add thing",
    filesChanged: [{ path: "src/file.ts", status: "modified", additions: 10, deletions: 5 }],
    parentHashes: [],
    ...overrides,
  };
}

describe("chunker", () => {
  it("groups commits into chunks of configured size", () => {
    const commits = Array.from({ length: 5 }, (_, i) =>
      makeCommit({
        hash: `${"a".repeat(39)}${i}`,
        date: `2024-03-0${i + 1}T10:00:00Z`,
        message: `commit ${i + 1}`,
      }),
    );

    const units = chunk(commits, { commitsPerChunk: 2, maxChunkTokens: 10000 });

    // 5 commits / 2 per chunk = 3 chunks (2, 2, 1)
    expect(units).toHaveLength(3);
    expect(units[0]!.commitHashes).toHaveLength(2);
    expect(units[1]!.commitHashes).toHaveLength(2);
    expect(units[2]!.commitHashes).toHaveLength(1);
  });

  it("renders text content with commit metadata but no email", () => {
    const commits = [
      makeCommit({
        hash: "abc1234" + "0".repeat(33),
        message: "feat: migrate payments",
        authorName: "Alice Chen",
        authorEmail: "alice@company.com",
      }),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 10000 });

    expect(units).toHaveLength(1);
    const content = units[0]!.content;
    expect(content).toContain("abc1234");
    expect(content).toContain("Alice Chen");
    expect(content).toContain("feat: migrate payments");
    expect(content).toContain("src/file.ts");
    // Email should NOT be in the rendered output
    expect(content).not.toContain("alice@company.com");
    expect(content).not.toContain("<");
  });

  it("generates deterministic TextUnit IDs from commit hashes", () => {
    const commits = [makeCommit({ hash: "a".repeat(40) })];

    const units1 = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 10000 });
    const units2 = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 10000 });

    expect(units1[0]!.id).toBe(units2[0]!.id);
    expect(units1[0]!.id).toMatch(/^tu:/);
  });

  it("splits chunks that exceed maxChunkTokens", () => {
    const commits = Array.from({ length: 4 }, (_, i) =>
      makeCommit({
        hash: `${"b".repeat(39)}${i}`,
        date: `2024-03-0${i + 1}T10:00:00Z`,
        message: "x".repeat(500), // Large message
        filesChanged: Array.from({ length: 10 }, (__, j) => ({
          path: `src/file${j}.ts`,
          status: "modified" as const,
          additions: 100,
          deletions: 50,
        })),
      }),
    );

    // Very small token limit forces splitting
    const units = chunk(commits, { commitsPerChunk: 4, maxChunkTokens: 200 });

    // Should split into more than 1 chunk
    expect(units.length).toBeGreaterThan(1);
    // Each chunk should have at least 1 commit
    for (const unit of units) {
      expect(unit.commitHashes.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("sets correct dateRange on text units", () => {
    const commits = [
      makeCommit({ hash: "a".repeat(40), date: "2024-03-01T10:00:00Z" }),
      makeCommit({ hash: "b".repeat(40), date: "2024-03-05T10:00:00Z" }),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 10000 });

    expect(units[0]!.dateRange.start).toBe("2024-03-01T10:00:00Z");
    expect(units[0]!.dateRange.end).toBe("2024-03-05T10:00:00Z");
  });

  it("handles single commit", () => {
    const units = chunk([makeCommit()], {
      commitsPerChunk: 10,
      maxChunkTokens: 10000,
    });

    expect(units).toHaveLength(1);
    expect(units[0]!.commitHashes).toHaveLength(1);
  });

  it("handles empty commit list", () => {
    const units = chunk([], { commitsPerChunk: 10, maxChunkTokens: 10000 });
    expect(units).toHaveLength(0);
  });

  // ================================================================
  // Merge commit deflation
  // ================================================================

  it("deflates merge commits: strips file changes, keeps message", () => {
    const commits = [
      makeCommit({
        hash: "a".repeat(40),
        message: "Merge: migrate billing to Stripe v3",
        parentHashes: ["parent1hash".padEnd(40, "0"), "parent2hash".padEnd(40, "0")],
        filesChanged: Array.from({ length: 30 }, (_, i) => ({
          path: `src/billing/file${i}.ts`,
          status: "modified" as const,
          additions: 10,
          deletions: 5,
        })),
      }),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 10000 });

    expect(units).toHaveLength(1);
    const content = units[0]!.content;
    // Message preserved
    expect(content).toContain("Merge: migrate billing to Stripe v3");
    // File changes stripped
    expect(content).not.toContain("src/billing/file0.ts");
  });

  it("does not deflate non-merge commits", () => {
    const commits = [
      makeCommit({
        hash: "a".repeat(40),
        parentHashes: ["singleparent".padEnd(40, "0")],
        filesChanged: [{ path: "src/foo.ts", status: "modified", additions: 5, deletions: 2 }],
      }),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 10000 });

    expect(units[0]!.content).toContain("src/foo.ts");
  });

  // ================================================================
  // Diff truncation
  // ================================================================

  it("truncates long diffs per file", () => {
    const longDiff = Array.from({ length: 100 }, (_, i) => `+line ${i}`).join("\n");

    const commits = [
      makeCommit({
        hash: "c".repeat(40),
        filesChanged: [
          {
            path: "src/big.ts",
            status: "modified",
            additions: 100,
            deletions: 0,
            diff: longDiff,
          },
        ],
      }),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 100000 });
    const content = units[0]!.content;

    // Should contain truncation marker
    expect(content).toContain("more lines");
    // Should NOT contain the last line of the original diff
    expect(content).not.toContain("+line 99");
    // Should contain early lines
    expect(content).toContain("+line 0");
  });

  it("does not truncate short diffs", () => {
    const shortDiff = "+added line 1\n+added line 2";

    const commits = [
      makeCommit({
        hash: "d".repeat(40),
        filesChanged: [
          {
            path: "src/small.ts",
            status: "modified",
            additions: 2,
            deletions: 0,
            diff: shortDiff,
          },
        ],
      }),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 100000 });
    const content = units[0]!.content;

    expect(content).toContain("+added line 1");
    expect(content).toContain("+added line 2");
    expect(content).not.toContain("more lines");
  });

  // ================================================================
  // Binary diff guard
  // ================================================================

  it("excludes binary file diffs", () => {
    const commits = [
      makeCommit({
        hash: "e".repeat(40),
        filesChanged: [
          {
            path: "assets/logo.png",
            status: "modified",
            additions: 0,
            deletions: 0,
            diff: "Binary files a/assets/logo.png and b/assets/logo.png differ",
          },
        ],
      }),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 100000 });
    const content = units[0]!.content;

    // Binary diff content should not appear
    expect(content).not.toContain("Binary files");
    // Path should still appear in the file summary
    expect(content).toContain("assets/logo.png");
  });

  // ================================================================
  // Message truncation
  // ================================================================

  it("truncates very long commit messages", () => {
    const longMessage = "feat: " + "x".repeat(600);

    const commits = [
      makeCommit({
        hash: "f".repeat(40),
        message: longMessage,
      }),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 100000 });
    const content = units[0]!.content;

    // Should be truncated with ellipsis
    expect(content).toContain("...");
    // Should not contain the full message
    expect(content).not.toContain("x".repeat(600));
    // Should contain the beginning
    expect(content).toContain("feat: ");
  });

  // ================================================================
  // File list cap
  // ================================================================

  it("caps file listings at MAX_FILES_SHOWN", () => {
    const commits = [
      makeCommit({
        hash: "g".repeat(40),
        filesChanged: Array.from({ length: 30 }, (_, i) => ({
          path: `src/module/file${i}.ts`,
          status: "modified" as const,
          additions: 1,
          deletions: 0,
        })),
      }),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 100000 });
    const content = units[0]!.content;

    // Should contain truncation marker
    expect(content).toContain("more files");
    // Should contain early files
    expect(content).toContain("src/module/file0.ts");
    // Should NOT contain files past the cap (cap is 20)
    expect(content).not.toContain("src/module/file25.ts");
  });

  // ================================================================
  // No redundant header
  // ================================================================

  it("does not include redundant date range header", () => {
    const commits = [
      makeCommit({
        hash: "h".repeat(40),
        date: "2024-03-01T10:00:00Z",
      }),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 10000 });
    const content = units[0]!.content;

    // Old format had "=== Commits from X to Y ===" — should be gone
    expect(content).not.toContain("===");
  });

  // ================================================================
  // Split rendering: diff files vs no-diff files
  // ================================================================

  it("renders files with diffs separately from files without", () => {
    const commits = [
      makeCommit({
        hash: "i".repeat(40),
        filesChanged: [
          {
            path: "src/nodiff.ts",
            status: "modified",
            additions: 5,
            deletions: 2,
          },
          {
            path: "src/withdiff.ts",
            status: "modified",
            additions: 10,
            deletions: 3,
            diff: "+new code here",
          },
        ],
      }),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 100000 });
    const content = units[0]!.content;

    // No-diff file gets compact summary
    expect(content).toContain("src/nodiff.ts +5-2");
    // Diff file gets --- header WITH stats and diff content
    expect(content).toContain("--- src/withdiff.ts +10-3");
    expect(content).toContain("+new code here");
  });

  // ================================================================
  // Additional edge cases from review
  // ================================================================

  it("excludes GIT binary patch diffs", () => {
    const commits = [
      makeCommit({
        hash: "j".repeat(40),
        filesChanged: [
          {
            path: "assets/icon.woff",
            status: "modified",
            additions: 0,
            deletions: 0,
            diff: "GIT binary patch\ndelta 42\nsome binary data",
          },
        ],
      }),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 100000 });
    const content = units[0]!.content;

    expect(content).not.toContain("GIT binary patch");
    expect(content).toContain("assets/icon.woff");
  });

  it("does not deflate root commits (empty parentHashes)", () => {
    const commits = [
      makeCommit({
        hash: "k".repeat(40),
        parentHashes: [],
        filesChanged: [{ path: "README.md", status: "added", additions: 10, deletions: 0 }],
      }),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 100000 });
    expect(units[0]!.content).toContain("README.md");
  });

  it("handles mixed merge and non-merge commits in same chunk", () => {
    const commits = [
      makeCommit({
        hash: "l".repeat(40),
        date: "2024-03-01T10:00:00Z",
        message: "feat: add payments",
        parentHashes: ["p1".padEnd(40, "0")],
        filesChanged: [{ path: "src/payments.ts", status: "added", additions: 50, deletions: 0 }],
      }),
      makeCommit({
        hash: "m".repeat(40),
        date: "2024-03-02T10:00:00Z",
        message: "Merge branch 'payments' into main",
        parentHashes: ["p1".padEnd(40, "0"), "p2".padEnd(40, "0")],
        filesChanged: [
          { path: "src/payments.ts", status: "added", additions: 50, deletions: 0 },
          { path: "src/billing.ts", status: "modified", additions: 5, deletions: 2 },
        ],
      }),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 100000 });
    const content = units[0]!.content;

    // Non-merge commit files preserved
    expect(content).toContain("src/payments.ts");
    // Merge commit message preserved
    expect(content).toContain("Merge branch 'payments' into main");
    // Merge commit files stripped
    expect(content).not.toContain("src/billing.ts");
  });

  it("enforces shared file budget across categories", () => {
    // 18 files without diffs + 5 files with diffs = 23 total
    // With shared budget of 20: should show 18 no-diff + 2 diff files
    const commits = [
      makeCommit({
        hash: "n".repeat(40),
        filesChanged: [
          ...Array.from({ length: 18 }, (_, i) => ({
            path: `src/nodiff${i}.ts`,
            status: "modified" as const,
            additions: 1,
            deletions: 0,
          })),
          ...Array.from({ length: 5 }, (_, i) => ({
            path: `src/withdiff${i}.ts`,
            status: "modified" as const,
            additions: 10,
            deletions: 5,
            diff: `+code in file ${i}`,
          })),
        ],
      }),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 100000 });
    const content = units[0]!.content;

    // All 18 no-diff files fit in budget
    expect(content).toContain("src/nodiff17.ts");
    // Only 2 diff files fit (20 - 18 = 2, but min 1)
    expect(content).toContain("src/withdiff0.ts");
    expect(content).toContain("src/withdiff1.ts");
    // Remaining 3 diff files truncated
    expect(content).toContain("more diffs");
    expect(content).not.toContain("src/withdiff4.ts");
  });

  // ================================================================
  // Smart chunk boundaries
  // ================================================================

  it("prefers splitting at author-change boundaries", () => {
    // 12 commits: Alice x 8, then Bob x 4
    // Fixed window at commitsPerChunk=10 would split at index 10
    // Smart boundary should split at index 8 (author change, within ±2 radius)
    const commits = [
      ...Array.from({ length: 8 }, (_, i) =>
        makeCommit({
          hash: `${"a".repeat(39)}${i}`,
          date: "2024-03-01T10:00:00Z",
          authorName: "Alice",
          message: `alice commit ${i}`,
        }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        makeCommit({
          hash: `${"b".repeat(39)}${i}`,
          date: "2024-03-01T10:00:00Z",
          authorName: "Bob",
          message: `bob commit ${i}`,
        }),
      ),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 100000 });

    expect(units).toHaveLength(2);
    // First chunk: Alice's 8 commits (split at author change boundary)
    expect(units[0]!.commitHashes).toHaveLength(8);
    expect(units[0]!.content).toContain("Alice");
    expect(units[0]!.content).not.toContain("Bob");
    // Second chunk: Bob's 4 commits
    expect(units[1]!.commitHashes).toHaveLength(4);
    expect(units[1]!.content).toContain("Bob");
  });

  it("prefers splitting at date-change boundaries", () => {
    // 12 commits: all Alice, 9 on March 1, 3 on March 2
    // Smart boundary should split at index 9 (date change)
    const commits = [
      ...Array.from({ length: 9 }, (_, i) =>
        makeCommit({
          hash: `${"a".repeat(39)}${i}`,
          date: "2024-03-01T10:00:00Z",
          authorName: "Alice",
          message: `commit ${i}`,
        }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        makeCommit({
          hash: `${"b".repeat(39)}${i}`,
          date: "2024-03-02T10:00:00Z",
          authorName: "Alice",
          message: `commit ${9 + i}`,
        }),
      ),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 100000 });

    expect(units).toHaveLength(2);
    expect(units[0]!.commitHashes).toHaveLength(9);
    expect(units[1]!.commitHashes).toHaveLength(3);
  });

  it("falls back to fixed window when no natural boundary nearby", () => {
    // 15 commits, all same author, same date — no natural boundary
    const commits = Array.from({ length: 15 }, (_, i) =>
      makeCommit({
        hash: `${"a".repeat(38)}${String(i).padStart(2, "0")}`,
        date: "2024-03-01T10:00:00Z",
        authorName: "Alice",
        message: `commit ${i}`,
      }),
    );

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 100000 });

    expect(units).toHaveLength(2);
    // Falls back to fixed split at target index 10
    expect(units[0]!.commitHashes).toHaveLength(10);
    expect(units[1]!.commitHashes).toHaveLength(5);
  });

  it("prefers author+date change (score 2) over author-only change (score 1)", () => {
    // 13 commits:
    //   [0-8]  Alice, March 1
    //   [9-10] Bob, March 1      ← author change at index 9 (score 1)
    //   [11-12] Carol, March 2   ← author+date change at index 11 (score 2)
    // commitsPerChunk=10, search range [8, 13) — both boundaries visible
    const commits = [
      ...Array.from({ length: 9 }, (_, i) =>
        makeCommit({
          hash: `${"a".repeat(38)}${String(i).padStart(2, "0")}`,
          date: "2024-03-01T10:00:00Z",
          authorName: "Alice",
        }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makeCommit({
          hash: `${"b".repeat(38)}${String(i).padStart(2, "0")}`,
          date: "2024-03-01T10:00:00Z",
          authorName: "Bob",
        }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makeCommit({
          hash: `${"c".repeat(38)}${String(i).padStart(2, "0")}`,
          date: "2024-03-02T10:00:00Z",
          authorName: "Carol",
        }),
      ),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 100000 });

    expect(units).toHaveLength(2);
    // Score 2 at index 11 beats score 1 at index 9
    expect(units[0]!.commitHashes).toHaveLength(11);
    expect(units[1]!.commitHashes).toHaveLength(2);
  });

  it("uses fixed windows for small commitsPerChunk values", () => {
    // With commitsPerChunk=2 (< 4), should use fixed windows regardless
    // even though there's an author change at index 1
    const commits = [
      makeCommit({
        hash: "a".repeat(40),
        authorName: "Alice",
        date: "2024-03-01T10:00:00Z",
      }),
      makeCommit({
        hash: "b".repeat(40),
        authorName: "Bob",
        date: "2024-03-02T10:00:00Z",
      }),
      makeCommit({
        hash: "c".repeat(40),
        authorName: "Bob",
        date: "2024-03-02T10:00:00Z",
      }),
      makeCommit({
        hash: "d".repeat(40),
        authorName: "Carol",
        date: "2024-03-03T10:00:00Z",
      }),
    ];

    const units = chunk(commits, { commitsPerChunk: 2, maxChunkTokens: 100000 });

    // Fixed windows: [0,1], [2,3]
    expect(units).toHaveLength(2);
    expect(units[0]!.commitHashes).toHaveLength(2);
    expect(units[1]!.commitHashes).toHaveLength(2);
  });
});

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("hello world")).toBe(3); // 11 / 4 = 2.75 → 3
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});
