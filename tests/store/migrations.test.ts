import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema, runMigrations } from "../../src/store/schema.js";

function createV1Database(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function getVersion(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM index_meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return !!row;
}

describe("Migration framework", () => {
  it("runs pending migrations on a v1 database", () => {
    const db = createV1Database();
    expect(getVersion(db)).toBe(1);

    runMigrations(db);

    expect(getVersion(db)).toBe(4);
    expect(tableExists(db, "text_unit_entities")).toBe(true);
    expect(tableExists(db, "community_entities")).toBe(true);
    db.close();
  });

  it("skips migrations when already at current version", () => {
    const db = createV1Database();
    runMigrations(db);
    const versionBefore = getVersion(db);

    runMigrations(db);
    expect(getVersion(db)).toBe(versionBefore);
    db.close();
  });

  it("throws when database version is newer than supported", () => {
    const db = createV1Database();
    db.prepare("UPDATE index_meta SET value = '999' WHERE key = 'schema_version'").run();

    expect(() => runMigrations(db)).toThrow(/newer than supported/);
    db.close();
  });

  it("populates junction tables from existing JSON data", () => {
    const db = createV1Database();

    db.prepare(
      `
      INSERT INTO entities (id, type, name, aliases, description, first_seen, last_seen, frequency, metadata)
      VALUES ('person:alice', 'PERSON', 'Alice', '[]', 'dev', '2024-01-01', '2024-06-01', 5, '{}')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO entities (id, type, name, aliases, description, first_seen, last_seen, frequency, metadata)
      VALUES ('module:src/pay', 'MODULE', 'src/pay', '[]', 'payments', '2024-01-01', '2024-06-01', 3, '{}')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO text_units (id, content, commit_hashes, date_start, date_end, entity_ids, relation_ids)
      VALUES ('tu:001', 'Alice fixed payments', '[]', '2024-01-01', '2024-01-05',
              '["person:alice","module:src/pay"]', '[]')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO communities (id, level, title, summary, entity_ids, parent_id, child_ids)
      VALUES ('comm:0:0', 0, 'Payments', 'Summary', '["person:alice","module:src/pay"]', NULL, '[]')
    `,
    ).run();

    runMigrations(db);

    const tueRows = db
      .prepare("SELECT * FROM text_unit_entities WHERE text_unit_id = 'tu:001'")
      .all();
    expect(tueRows).toHaveLength(2);

    const ceRows = db
      .prepare("SELECT * FROM community_entities WHERE community_id = 'comm:0:0'")
      .all();
    expect(ceRows).toHaveLength(2);

    db.close();
  });

  it("creates composite indexes on relations in v3 migration", () => {
    const db = createV1Database();
    runMigrations(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='relations'")
      .all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain("idx_relations_source_type");
    expect(indexNames).toContain("idx_relations_target_type");
    db.close();
  });

  it("adds embedding columns to entities and communities in v4 migration", () => {
    const db = createV1Database();
    runMigrations(db);

    const entityCols = db.pragma("table_info(entities)") as { name: string }[];
    const entityColNames = entityCols.map((c) => c.name);
    expect(entityColNames).toContain("embedding");

    const commCols = db.pragma("table_info(communities)") as { name: string }[];
    const commColNames = commCols.map((c) => c.name);
    expect(commColNames).toContain("embedding");

    db.close();
  });

  it("skips dangling entity references in JSON during migration", () => {
    const db = createV1Database();

    db.prepare(
      `
      INSERT INTO entities (id, type, name, aliases, description, first_seen, last_seen, frequency, metadata)
      VALUES ('person:alice', 'PERSON', 'Alice', '[]', 'dev', '2024-01-01', '2024-06-01', 5, '{}')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO text_units (id, content, commit_hashes, date_start, date_end, entity_ids, relation_ids)
      VALUES ('tu:001', 'content', '[]', '2024-01-01', '2024-01-05',
              '["person:alice","nonexistent:entity"]', '[]')
    `,
    ).run();

    runMigrations(db);

    const rows = db.prepare("SELECT * FROM text_unit_entities WHERE text_unit_id = 'tu:001'").all();
    expect(rows).toHaveLength(1);

    db.close();
  });
});
