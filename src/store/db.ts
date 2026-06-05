import Database from "better-sqlite3";
import { mkdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../shared/logger.js";
import { initSchema, runMigrations } from "./schema.js";

const DB_FILENAME = "hald.db";
const LEGACY_DB_FILENAME = "oracle.db";

/**
 * Resolves the active DB path inside `storagePath`.
 *
 * Prefers `hald.db`. Falls back to legacy `oracle.db` only when the new file
 * is absent and the legacy file exists — so callers (e.g. the reset command)
 * can still locate a pre-rename index without triggering migration.
 */
export function resolveDbPath(storagePath: string): string {
  const haldPath = join(storagePath, DB_FILENAME);
  if (existsSync(haldPath)) return haldPath;
  const legacyPath = join(storagePath, LEGACY_DB_FILENAME);
  if (existsSync(legacyPath)) return legacyPath;
  return haldPath;
}

/**
 * Opens (or creates) the SQLite database and initializes the schema.
 * For tests, pass ":memory:" as storagePath.
 *
 * Performs a one-time migration from `oracle.db` → `hald.db` if the legacy
 * file is found alongside no new file. Renames journal siblings (-shm, -wal)
 * best-effort. On rename failure, keeps using the legacy filename to avoid
 * data loss.
 */
export function openDatabase(storagePath: string): Database.Database {
  let db: Database.Database;

  if (storagePath === ":memory:") {
    db = new Database(":memory:");
  } else {
    if (!existsSync(storagePath)) {
      mkdirSync(storagePath, { recursive: true });
    }

    const dbPath = migrateLegacyDbFile(storagePath);

    db = new Database(dbPath);
    logger.debug("Database opened", { path: dbPath });
  }

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  initSchema(db);
  runMigrations(db);

  return db;
}

function migrateLegacyDbFile(storagePath: string): string {
  const haldPath = join(storagePath, DB_FILENAME);
  const legacyPath = join(storagePath, LEGACY_DB_FILENAME);

  if (existsSync(haldPath) || !existsSync(legacyPath)) {
    return haldPath;
  }

  // Checkpoint the legacy WAL into the main DB file before renaming. The -wal
  // and -shm siblings are renamed separately and best-effort below, so a crash
  // mid-rename could otherwise strip un-checkpointed transactions. Skip
  // gracefully if the file is missing/locked/corrupt — the rename still runs.
  try {
    const legacyDb = new Database(legacyPath);
    try {
      legacyDb.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      legacyDb.close();
    }
  } catch (err) {
    logger.debug("Could not checkpoint legacy oracle.db WAL before rename", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    renameSync(legacyPath, haldPath);
    for (const suffix of ["-shm", "-wal"]) {
      const from = legacyPath + suffix;
      const to = haldPath + suffix;
      if (existsSync(from)) {
        try {
          renameSync(from, to);
        } catch {
          // Journal files may be locked or missing — non-fatal.
        }
      }
    }
    logger.info("Migrated database file: oracle.db → hald.db", { storagePath });
    return haldPath;
  } catch (err) {
    logger.warn("Could not migrate oracle.db → hald.db; using legacy filename", {
      error: err instanceof Error ? err.message : String(err),
    });
    return legacyPath;
  }
}
