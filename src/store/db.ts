import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../shared/logger.js";
import { initSchema } from "./schema.js";

/**
 * Opens (or creates) the SQLite database and initializes the schema.
 * For tests, pass ":memory:" as storagePath.
 */
export function openDatabase(storagePath: string): Database.Database {
  let db: Database.Database;

  if (storagePath === ":memory:") {
    db = new Database(":memory:");
  } else {
    const dbPath = join(storagePath, "oracle.db");

    if (!existsSync(storagePath)) {
      mkdirSync(storagePath, { recursive: true });
    }

    db = new Database(dbPath);
    logger.debug("Database opened", { path: dbPath });
  }

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  initSchema(db);

  return db;
}
