import type Database from "better-sqlite3";

const SCHEMA_VERSION = 1;

export function initSchema(db: Database.Database): void {
  db.exec(`
    -- ============================================================
    -- Core tables
    -- ============================================================

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      description TEXT NOT NULL DEFAULT '',
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      frequency INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source_id TEXT NOT NULL REFERENCES entities(id),
      target_id TEXT NOT NULL REFERENCES entities(id),
      weight REAL NOT NULL DEFAULT 1.0,
      description TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '[]',
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS text_units (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      commit_hashes TEXT NOT NULL DEFAULT '[]',
      date_start TEXT NOT NULL,
      date_end TEXT NOT NULL,
      entity_ids TEXT NOT NULL DEFAULT '[]',
      relation_ids TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS communities (
      id TEXT PRIMARY KEY,
      level INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      entity_ids TEXT NOT NULL DEFAULT '[]',
      parent_id TEXT,
      child_ids TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS commits (
      hash TEXT PRIMARY KEY,
      author_name TEXT NOT NULL,
      author_email TEXT NOT NULL,
      date TEXT NOT NULL,
      message TEXT NOT NULL,
      files_changed TEXT NOT NULL DEFAULT '[]',
      parent_hashes TEXT NOT NULL DEFAULT '[]',
      text_unit_id TEXT,
      indexed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- ============================================================
    -- Performance indexes
    -- ============================================================

    CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_id);
    CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_id);
    CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(type);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
    CREATE INDEX IF NOT EXISTS idx_communities_level ON communities(level);
    CREATE INDEX IF NOT EXISTS idx_commits_date ON commits(date);
    CREATE INDEX IF NOT EXISTS idx_commits_author ON commits(author_email);

    -- ============================================================
    -- FTS5 full-text search (content-synced with triggers)
    -- ============================================================

    CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
      name, aliases, description,
      content='entities',
      content_rowid='rowid'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS communities_fts USING fts5(
      title, summary,
      content='communities',
      content_rowid='rowid'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS text_units_fts USING fts5(
      content,
      content='text_units',
      content_rowid='rowid'
    );
  `);

  // Triggers must be created individually (can't be inside multi-statement exec
  // with virtual table creation in some SQLite builds)
  createFtsTriggers(db);

  // Set schema version
  db.prepare(
    `INSERT OR IGNORE INTO index_meta (key, value) VALUES ('schema_version', ?)`,
  ).run(String(SCHEMA_VERSION));
}

function createFtsTriggers(db: Database.Database): void {
  // --- entities_fts triggers ---
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS entities_fts_ai AFTER INSERT ON entities BEGIN
      INSERT INTO entities_fts(rowid, name, aliases, description)
      VALUES (new.rowid, new.name, new.aliases, new.description);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS entities_fts_ad AFTER DELETE ON entities BEGIN
      INSERT INTO entities_fts(entities_fts, rowid, name, aliases, description)
      VALUES ('delete', old.rowid, old.name, old.aliases, old.description);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS entities_fts_au AFTER UPDATE ON entities BEGIN
      INSERT INTO entities_fts(entities_fts, rowid, name, aliases, description)
      VALUES ('delete', old.rowid, old.name, old.aliases, old.description);
      INSERT INTO entities_fts(rowid, name, aliases, description)
      VALUES (new.rowid, new.name, new.aliases, new.description);
    END;
  `);

  // --- communities_fts triggers ---
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS communities_fts_ai AFTER INSERT ON communities BEGIN
      INSERT INTO communities_fts(rowid, title, summary)
      VALUES (new.rowid, new.title, new.summary);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS communities_fts_ad AFTER DELETE ON communities BEGIN
      INSERT INTO communities_fts(communities_fts, rowid, title, summary)
      VALUES ('delete', old.rowid, old.title, old.summary);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS communities_fts_au AFTER UPDATE ON communities BEGIN
      INSERT INTO communities_fts(communities_fts, rowid, title, summary)
      VALUES ('delete', old.rowid, old.title, old.summary);
      INSERT INTO communities_fts(rowid, title, summary)
      VALUES (new.rowid, new.title, new.summary);
    END;
  `);

  // --- text_units_fts triggers ---
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS text_units_fts_ai AFTER INSERT ON text_units BEGIN
      INSERT INTO text_units_fts(rowid, content)
      VALUES (new.rowid, new.content);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS text_units_fts_ad AFTER DELETE ON text_units BEGIN
      INSERT INTO text_units_fts(text_units_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS text_units_fts_au AFTER UPDATE ON text_units BEGIN
      INSERT INTO text_units_fts(text_units_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
      INSERT INTO text_units_fts(rowid, content)
      VALUES (new.rowid, new.content);
    END;
  `);
}
