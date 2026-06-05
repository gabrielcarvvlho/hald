import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import simpleGit from "simple-git";
import type { CommitData, TextUnit } from "../../src/shared/types.js";

// ----------------------------------------------------------------
// chunker mock: pass-through to the real implementation, but allow a
// test to force an arbitrary text-unit count so we can exercise the
// MAX_CHUNKS guard without committing 500+ times to a real repo.
// ----------------------------------------------------------------
let forcedTextUnits: TextUnit[] | null = null;

vi.mock("../../src/pipeline/chunker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pipeline/chunker.js")>();
  return {
    ...actual,
    chunk: (commits: CommitData[], options: Parameters<typeof actual.chunk>[1]): TextUnit[] => {
      if (forcedTextUnits) return forcedTextUnits;
      return actual.chunk(commits, options);
    },
  };
});

import {
  startAgentSession,
  getSession,
  getNextChunk,
  submitExtraction,
  finalizeSession,
  clearSession,
} from "../../src/mcp/agent-session.js";

// ================================================================
// Helpers
// ================================================================

/** Build a valid <extraction> envelope with one PERSON entity. */
function validExtractionXml(name = "Alice"): string {
  return [
    "<extraction>",
    "  <entities>",
    `    <entity><name>${name}</name><type>PERSON</type><description>Developer</description></entity>`,
    "    <entity><name>src/core</name><type>MODULE</type><description>Core module</description></entity>",
    "  </entities>",
    "  <relations>",
    `    <relation><source>${name}</source><target>src/core</target><type>AUTHORED</type><description>authored</description><weight>8</weight></relation>`,
    "  </relations>",
    "</extraction>",
  ].join("\n");
}

async function createRepo(dir: string, commitCount: number): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.name", "Alice");
  await git.addConfig("user.email", "alice@test.com");
  mkdirSync(join(dir, "src/core"), { recursive: true });
  for (let i = 1; i <= commitCount; i++) {
    writeFileSync(join(dir, "src/core/index.ts"), `export const v = ${i};`);
    await git.add(".");
    await git.commit(`feat: change ${i} touching Alice and src/core`);
  }
}

// ================================================================
// Setup: an isolated temp repo + storage, wired via env vars so
// loadConfig (called inside startAgentSession) targets them.
// ================================================================

let tmpDir: string;
let repoDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  tmpDir = join(tmpdir(), `hald-agentsession-${Date.now()}`);
  repoDir = join(tmpDir, "repo");
  await createRepo(repoDir, 4);

  for (const k of ["HALD_REPO", "HALD_STORAGE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.HALD_REPO = repoDir;
  process.env.HALD_STORAGE = join(tmpDir, "storage");
  // Agent-mediated mode is the no-API-key path; ensure none leak in from CI.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

afterEach(() => {
  forcedTextUnits = null;
  clearSession();
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ================================================================
// Happy path: start → next → submit → finalize
// ================================================================

describe("agent-session state machine — happy path", () => {
  it("walks start → getNextChunk → submitExtraction → finalizeSession", async () => {
    const { chunkCount, commitCount } = await startAgentSession({ full: true });
    expect(commitCount).toBe(4);
    expect(chunkCount).toBeGreaterThan(0);
    expect(getSession()).not.toBeNull();

    // Drive the extraction loop to completion.
    let guard = 0;
    for (;;) {
      const chunk = getNextChunk();
      if (chunk.done) {
        expect(chunk.extracted).toBe(chunk.total);
        break;
      }
      // The chunk carries the prompts the host would feed to its own LLM.
      expect(chunk.systemPrompt.length).toBeGreaterThan(0);
      expect(chunk.userPrompt).toContain("<commit_data>");

      const res = submitExtraction(validExtractionXml());
      expect(res.accepted).toBe(true);
      expect(res.entities).toBeGreaterThan(0);
      expect(res.warning).toBeUndefined();

      if (++guard > 50) throw new Error("loop did not terminate");
    }

    const result = await finalizeSession();
    expect(result.commitsProcessed).toBe(4);
    expect(result.entitiesFound).toBeGreaterThan(0);
    expect(result.relationsFound).toBeGreaterThan(0);
    // Finalize tears down the session.
    expect(getSession()).toBeNull();
  });

  it("getNextChunk reports done immediately when there is nothing to do is not possible — but reports done after the last chunk", async () => {
    const { chunkCount } = await startAgentSession({ full: true });
    for (let i = 0; i < chunkCount; i++) {
      const chunk = getNextChunk();
      expect(chunk.done).toBe(false);
      submitExtraction(validExtractionXml());
    }
    const done = getNextChunk();
    expect(done.done).toBe(true);
  });
});

// ================================================================
// Empty-extraction warning (the new non-advancing soft-fail)
// ================================================================

describe("agent-session — empty extraction", () => {
  it("does not advance and returns a warning when XML parses to 0 entities and 0 relations", async () => {
    await startAgentSession({ full: true });

    const before = getNextChunk();
    expect(before.done).toBe(false);
    const startIndex = before.done ? -1 : before.index;

    // Unwrapped XML (missing the <extraction> envelope) parses to nothing.
    const res = submitExtraction("<entities></entities>");
    expect(res.accepted).toBe(false);
    expect(res.entities).toBe(0);
    expect(res.relations).toBe(0);
    expect(res.warning).toBeDefined();
    expect(res.warning).toContain("<extraction>");
    expect(res.progress).toContain("not advanced");

    // The session must hold position: the same chunk is served again.
    const after = getNextChunk();
    expect(after.done).toBe(false);
    if (!after.done && !before.done) {
      expect(after.index).toBe(startIndex);
    }

    // Resubmitting valid XML now advances.
    const ok = submitExtraction(validExtractionXml());
    expect(ok.accepted).toBe(true);
    const advanced = getNextChunk();
    if (!advanced.done && !before.done) {
      expect(advanced.index).toBe(startIndex + 1);
    }
  });

  it("counts non-advanced empty chunks as failures in the finalize summary", async () => {
    const { chunkCount } = await startAgentSession({ full: true });

    // Submit one empty (rejected, not advanced), then valid for every real chunk.
    submitExtraction("not even xml");
    for (let i = 0; i < chunkCount; i++) {
      submitExtraction(validExtractionXml());
    }

    const result = await finalizeSession();
    // tokenUsage.requests mirrors successfully-extracted chunks.
    expect(result.tokenUsage.requests).toBe(chunkCount);
  });
});

// ================================================================
// 30-minute timeout auto-clear
// ================================================================

describe("agent-session — stale session auto-clear", () => {
  it("getSession() auto-clears a session older than the 30-minute timeout", async () => {
    await startAgentSession({ full: true });
    const session = getSession();
    expect(session).not.toBeNull();

    // Backdate the session creation past the 30-minute TTL.
    session!.createdAt = new Date(Date.now() - 31 * 60 * 1000);

    expect(getSession()).toBeNull();
  });

  it("a fresh session is not cleared", async () => {
    await startAgentSession({ full: true });
    expect(getSession()).not.toBeNull();
    // Re-reading must not clear it.
    expect(getSession()).not.toBeNull();
  });
});

// ================================================================
// MAX_CHUNKS = 500 guard
// ================================================================

describe("agent-session — MAX_CHUNKS guard", () => {
  it("throws when chunking produces more than 500 text units", async () => {
    // Force the (mocked) chunker to emit 501 units regardless of commit count.
    forcedTextUnits = Array.from({ length: 501 }, (_, i) => ({
      id: `tu:${i}`,
      content: `commit chunk ${i}`,
      commitHashes: [`hash${i}`],
      dateRange: { start: "2024-01-01", end: "2024-01-01" },
      entityIds: [],
      relationIds: [],
    }));

    await expect(startAgentSession({ full: true })).rejects.toThrow(/Too many chunks/);
    // The guard must not leave a dangling active session.
    expect(getSession()).toBeNull();
  });

  it("accepts exactly 500 text units (boundary)", async () => {
    forcedTextUnits = Array.from({ length: 500 }, (_, i) => ({
      id: `tu:${i}`,
      content: `commit chunk ${i}`,
      commitHashes: [`hash${i}`],
      dateRange: { start: "2024-01-01", end: "2024-01-01" },
      entityIds: [],
      relationIds: [],
    }));

    const { chunkCount } = await startAgentSession({ full: true });
    expect(chunkCount).toBe(500);
    expect(getSession()).not.toBeNull();
  });
});
