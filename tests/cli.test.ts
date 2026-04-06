import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/store/db.js";
import { Store } from "../src/store/queries.js";
import { EntityType, RelationType } from "../src/shared/types.js";

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
    expect(stdout).toContain("index");
    expect(stdout).toContain("query");
    expect(stdout).toContain("stats");
    expect(stdout).toContain("serve");
  });

  it("--version shows version", () => {
    const { stdout, exitCode } = runCLI(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("0.1.0");
  });

  it("index --help shows index options", () => {
    const { stdout, exitCode } = runCLI(["index", "--help"]);
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
    tmpDir = join(tmpdir(), `git-oracle-cli-test-${Date.now()}`);
    storageDir = join(tmpDir, ".git-oracle");
    mkdirSync(storageDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stats on empty index shows zero counts (no crash)", () => {
    const emptyDir = join(tmpDir, "empty");
    mkdirSync(emptyDir, { recursive: true });
    const { stdout, exitCode } = runCLI(["stats"], {
      GIT_ORACLE_REPO: emptyDir,
    });
    expect(exitCode).toBe(0);
    // Should show stats with zero counts rather than crash
    expect(stdout).toContain("Entities:");
    expect(stdout).toContain("0");
    expect(stdout).toContain("Last indexed commit: none");
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
      GIT_ORACLE_REPO: tmpDir,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Entities:");
    expect(stdout).toContain("abc123");
  });
});

describe("CLI — query", () => {
  let tmpDir: string;
  let storageDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `git-oracle-cli-query-${Date.now()}`);
    storageDir = join(tmpDir, ".git-oracle");
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

  it("query on empty index shows error message", () => {
    const emptyDir = join(tmpDir, "empty");
    mkdirSync(emptyDir, { recursive: true });
    const { stdout, exitCode } = runCLI(["query", "who knows payments?"], {
      GIT_ORACLE_REPO: emptyDir,
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("No index found");
  });

  it("local query finds entities", () => {
    const { stdout, exitCode } = runCLI(["query", "who works on payments?"], {
      GIT_ORACLE_REPO: tmpDir,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("payments");
  });

  it("global query does not crash", () => {
    const { stdout, exitCode } = runCLI(
      ["query", "what are the main architectural decisions?", "--type", "global"],
      { GIT_ORACLE_REPO: tmpDir },
    );

    expect(exitCode).toBe(0);
    // May show communities or "No relevant communities" — just should not crash
    expect(stdout).toBeTruthy();
  });
});
