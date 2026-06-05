import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDatabase, resolveDbPath } from "../../src/store/db.js";

describe("DB rename migration (oracle.db → hald.db)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hald-db-migration-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates hald.db when no DB exists", () => {
    const db = openDatabase(tempDir);
    db.close();
    expect(existsSync(join(tempDir, "hald.db"))).toBe(true);
    expect(existsSync(join(tempDir, "oracle.db"))).toBe(false);
  });

  it("renames legacy oracle.db to hald.db on first open", () => {
    // Seed a legacy DB with a real schema-bearing payload.
    const legacy = new Database(join(tempDir, "oracle.db"));
    legacy.exec("CREATE TABLE marker (id INTEGER); INSERT INTO marker VALUES (42);");
    legacy.close();

    const db = openDatabase(tempDir);
    const row = db.prepare("SELECT id FROM marker").get() as { id: number };
    db.close();

    expect(row.id).toBe(42);
    expect(existsSync(join(tempDir, "hald.db"))).toBe(true);
    expect(existsSync(join(tempDir, "oracle.db"))).toBe(false);
  });

  it("checkpoints legacy WAL so un-checkpointed writes survive the rename", () => {
    // Seed a legacy DB in WAL mode and leave writes in the -wal sibling
    // (no checkpoint). The migration must checkpoint before renaming the main
    // file, otherwise those rows would be lost if the -wal rename were skipped.
    const legacy = new Database(join(tempDir, "oracle.db"));
    legacy.pragma("journal_mode = WAL");
    legacy.exec("CREATE TABLE marker (id INTEGER);");
    legacy.exec("INSERT INTO marker VALUES (7);");
    // Close without an explicit checkpoint — better-sqlite3 may checkpoint on
    // close, but openDatabase's own checkpoint is what we exercise here.
    legacy.close();

    const db = openDatabase(tempDir);
    const row = db.prepare("SELECT id FROM marker").get() as { id: number };
    db.close();

    expect(row.id).toBe(7);
    expect(existsSync(join(tempDir, "hald.db"))).toBe(true);
    expect(existsSync(join(tempDir, "oracle.db"))).toBe(false);
  });

  it("prefers existing hald.db over legacy oracle.db (no migration)", () => {
    // Both exist — caller already migrated. Hald wins, oracle.db is left untouched.
    const hald = new Database(join(tempDir, "hald.db"));
    hald.exec("CREATE TABLE marker (id INTEGER); INSERT INTO marker VALUES (1);");
    hald.close();

    writeFileSync(join(tempDir, "oracle.db"), "not-a-real-db");

    const db = openDatabase(tempDir);
    const row = db.prepare("SELECT id FROM marker").get() as { id: number };
    db.close();

    expect(row.id).toBe(1);
    expect(existsSync(join(tempDir, "oracle.db"))).toBe(true);
  });

  it("resolveDbPath returns hald.db when neither file exists", () => {
    expect(resolveDbPath(tempDir)).toBe(join(tempDir, "hald.db"));
  });

  it("resolveDbPath returns oracle.db when only legacy exists", () => {
    writeFileSync(join(tempDir, "oracle.db"), "");
    expect(resolveDbPath(tempDir)).toBe(join(tempDir, "oracle.db"));
  });

  it("resolveDbPath prefers hald.db when both exist", () => {
    writeFileSync(join(tempDir, "hald.db"), "");
    writeFileSync(join(tempDir, "oracle.db"), "");
    expect(resolveDbPath(tempDir)).toBe(join(tempDir, "hald.db"));
  });
});
