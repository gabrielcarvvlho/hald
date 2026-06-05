import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { simpleGit } from "simple-git";
import { openDatabase } from "../src/store/db.js";
import { Store } from "../src/store/queries.js";
import { EntityType, RelationType } from "../src/shared/types.js";

// Empty values keep dotenv from injecting real keys (.env in repo root):
// dotenv never overrides an already-set env var, so an empty string wins.
const NO_API_KEYS: Record<string, string> = {
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  GOOGLE_API_KEY: "",
  GEMINI_API_KEY: "",
  ZHIPU_API_KEY: "",
};

const PKG_VERSION = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
).version;

const CLI_PATH = join(__dirname, "..", "src", "cli.ts");

function runCLI(
  args: string[],
  env?: Record<string, string>,
): { stdout: string; exitCode: number } {
  const cmd = `npx tsx ${CLI_PATH} ${args.map((a) => `'${a}'`).join(" ")}`;
  try {
    const stdout = execSync(cmd, {
      encoding: "utf-8",
      timeout: 15_000,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout ?? "") + (err.stderr ?? ""),
      exitCode: err.status ?? 1,
    };
  }
}

describe("CLI — help and version", () => {
  it("--help shows all commands", () => {
    const { stdout, exitCode } = runCLI(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("scan");
    expect(stdout).toContain("ask");
    expect(stdout).toContain("stats");
    expect(stdout).toContain("serve");
  });

  it("--version shows version", () => {
    const { stdout, exitCode } = runCLI(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(PKG_VERSION);
  });

  it("scan --help shows scan options", () => {
    const { stdout, exitCode } = runCLI(["scan", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--full");
    expect(stdout).toContain("--max-commits");
    expect(stdout).toContain("--since");
    expect(stdout).toContain("--provider");
    expect(stdout).toContain("--yes");
  });

  it("unknown command shows error", () => {
    const { stdout, exitCode } = runCLI(["nonexistent-command"]);
    expect(exitCode).toBe(1);
    expect(stdout.toLowerCase()).toContain("unknown command");
  });
});

describe("CLI — stats", () => {
  let tmpDir: string;
  let storageDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `hald-cli-test-${Date.now()}`);
    storageDir = join(tmpDir, ".hald");
    mkdirSync(storageDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stats on empty index shows zero counts (no crash)", () => {
    const emptyDir = join(tmpDir, "empty");
    mkdirSync(emptyDir, { recursive: true });
    const { stdout, exitCode } = runCLI(["stats"], {
      HALD_REPO: emptyDir,
    });
    expect(exitCode).toBe(0);
    // Card shows the expected labels and zero counts, with a "(none)" marker
    // for the missing last-indexed-commit instead of crashing.
    expect(stdout).toContain("Entities");
    expect(stdout).toContain("Relations");
    expect(stdout).toContain("Communities");
    expect(stdout).toContain("0");
    expect(stdout).toContain("(none)");
  });

  it("stats on populated index shows counts", () => {
    // Create a store with data
    const db = openDatabase(storageDir);
    const store = new Store(db);

    store.upsertEntity({
      id: "person:test",
      type: EntityType.PERSON,
      name: "Test Person",
      aliases: [],
      description: "Test",
      firstSeen: "2024-01-01",
      lastSeen: "2024-01-01",
      frequency: 1,
      metadata: {},
    });
    store.setMeta("last_indexed_commit", "abc123");
    store.setMeta("last_indexed_at", "2024-01-01T00:00:00Z");
    store.close();

    const { stdout, exitCode } = runCLI(["stats"], {
      HALD_REPO: tmpDir,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Entities");
    // Short hash (7 chars) — current data only has 6 chars so the full hash appears
    expect(stdout).toContain("abc123");
    expect(stdout).toContain("Last commit");
  });
});

describe("CLI — scan", () => {
  let emptyRepo: string;
  let repoWithCommits: string;

  beforeAll(async () => {
    // A freshly-init'd repo with zero commits.
    emptyRepo = join(tmpdir(), `hald-cli-scan-empty-${Date.now()}`);
    mkdirSync(emptyRepo, { recursive: true });
    const empty = simpleGit(emptyRepo);
    await empty.init();
    await empty.addConfig("user.name", "Nobody");
    await empty.addConfig("user.email", "nobody@example.com");

    // A repo with one commit — exercises the provider check (the empty repo
    // returns early before the provider is ever needed).
    repoWithCommits = join(tmpdir(), `hald-cli-scan-commit-${Date.now()}`);
    mkdirSync(repoWithCommits, { recursive: true });
    const withCommit = simpleGit(repoWithCommits);
    await withCommit.init();
    await withCommit.addConfig("user.name", "Nobody");
    await withCommit.addConfig("user.email", "nobody@example.com");
    writeFileSync(join(repoWithCommits, "README.md"), "# sample\n");
    await withCommit.add(".");
    await withCommit.commit("chore: initial commit");
  }, 30_000);

  afterAll(() => {
    rmSync(emptyRepo, { recursive: true, force: true });
    rmSync(repoWithCommits, { recursive: true, force: true });
  });

  it("with no API key exits with actionable guidance before any prompt", () => {
    const { stdout, exitCode } = runCLI(["scan"], {
      ...NO_API_KEYS,
      HALD_REPO: repoWithCommits,
    });
    // Exits non-zero with key guidance, and never reaches the cost estimate
    // or the "Proceed?" prompt (which is what used to happen).
    expect(exitCode).toBe(1);
    expect(stdout).toContain("ANTHROPIC_API_KEY");
    expect(stdout).toContain("OPENAI_API_KEY");
    expect(stdout).not.toContain("Estimated cost");
    expect(stdout).not.toContain("Proceed?");
    // Don't mis-price an unknown provider as Anthropic.
    expect(stdout).not.toContain("Claude Sonnet");
  });

  it("on a fresh repo with no commits does not crash", () => {
    // With a key present, scan should reach the empty-repo path and print the
    // friendly "no commits" message instead of "Indexing failed: <git error>".
    const { stdout, exitCode } = runCLI(["scan", "--provider", "openai"], {
      OPENAI_API_KEY: "sk-test-dummy",
      HALD_REPO: emptyRepo,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No new commits");
    expect(stdout).not.toContain("Indexing failed");
  });
});

describe("CLI — ask", () => {
  let tmpDir: string;
  let storageDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `hald-cli-query-${Date.now()}`);
    storageDir = join(tmpDir, ".hald");
    mkdirSync(storageDir, { recursive: true });

    const db = openDatabase(storageDir);
    const store = new Store(db);

    store.upsertEntity({
      id: "person:alice",
      type: EntityType.PERSON,
      name: "Alice Chen",
      aliases: ["alice"],
      description: "Lead developer",
      firstSeen: "2024-01-01",
      lastSeen: "2024-06-01",
      frequency: 10,
      metadata: {},
    });
    store.upsertEntity({
      id: "module:src/payments",
      type: EntityType.MODULE,
      name: "src/payments",
      aliases: ["payments"],
      description: "Payments service module",
      firstSeen: "2024-01-01",
      lastSeen: "2024-06-01",
      frequency: 8,
      metadata: {},
    });
    store.upsertRelation({
      id: "rel:alice-payments",
      type: RelationType.AUTHORED,
      sourceId: "person:alice",
      targetId: "module:src/payments",
      weight: 9,
      description: "Alice authored payments",
      evidence: [],
      firstSeen: "2024-01-01",
      lastSeen: "2024-06-01",
    });
    store.upsertCommunity({
      id: "comm:0:0",
      level: 0,
      title: "Payments Team",
      summary: "Alice works on the payments module.",
      entityIds: ["person:alice", "module:src/payments"],
      childIds: [],
    });
    store.setMeta("last_indexed_commit", "abc123");
    store.close();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ask on empty index shows error message", () => {
    const emptyDir = join(tmpDir, "empty");
    mkdirSync(emptyDir, { recursive: true });
    const { stdout, exitCode } = runCLI(["ask", "who knows payments?"], {
      HALD_REPO: emptyDir,
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("No index found");
  });

  it("local query finds entities", () => {
    const { stdout, exitCode } = runCLI(["ask", "who works on payments?"], {
      HALD_REPO: tmpDir,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("payments");
  });

  it("global query does not crash", () => {
    const { stdout, exitCode } = runCLI(
      ["ask", "what are the main architectural decisions?", "--type", "global"],
      { HALD_REPO: tmpDir },
    );

    expect(exitCode).toBe(0);
    // May show communities or "No relevant communities" — just should not crash
    expect(stdout).toBeTruthy();
  });
});
