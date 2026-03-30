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
    filesChanged: [
      { path: "src/file.ts", status: "modified", additions: 10, deletions: 5 },
    ],
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

  it("renders text content with commit metadata", () => {
    const commits = [
      makeCommit({
        hash: "abc1234" + "0".repeat(33),
        message: "feat: migrate payments",
        authorName: "Alice Chen",
      }),
    ];

    const units = chunk(commits, { commitsPerChunk: 10, maxChunkTokens: 10000 });

    expect(units).toHaveLength(1);
    const content = units[0]!.content;
    expect(content).toContain("abc1234");
    expect(content).toContain("Alice Chen");
    expect(content).toContain("feat: migrate payments");
    expect(content).toContain("src/file.ts");
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
});

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("hello world")).toBe(3); // 11 / 4 = 2.75 → 3
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});
