import type Database from "better-sqlite3";
import type {
  Entity,
  EntityId,
  EntityType,
  Relation,
  RelationId,
  TextUnit,
  TextUnitId,
  Community,
  CommunityId,
  CommitData,
  CommitHash,
} from "../shared/types.js";

export interface StoreStats {
  entities: number;
  relations: number;
  textUnits: number;
  communities: number;
  commits: number;
}

export class Store {
  private db: Database.Database;

  // Pre-compiled statements (lazy — created on first use)
  private _stmts: ReturnType<typeof prepareStatements> | null = null;
  private get stmts() {
    if (!this._stmts) this._stmts = prepareStatements(this.db);
    return this._stmts;
  }

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Wrap multiple operations in a single SQLite transaction. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ================================================================
  // Entities
  // ================================================================

  upsertEntity(entity: Entity): void {
    this.stmts.upsertEntity.run({
      id: entity.id,
      type: entity.type,
      name: entity.name,
      aliases: JSON.stringify(entity.aliases),
      description: entity.description,
      firstSeen: entity.firstSeen,
      lastSeen: entity.lastSeen,
      frequency: entity.frequency,
      metadata: JSON.stringify(entity.metadata),
    });
  }

  getEntity(id: EntityId): Entity | null {
    const row = this.stmts.getEntity.get(id) as EntityRow | undefined;
    return row ? toEntity(row) : null;
  }

  getEntitiesByType(type: EntityType): Entity[] {
    const rows = this.stmts.getEntitiesByType.all(type) as EntityRow[];
    return rows.map(toEntity);
  }

  searchEntities(query: string, limit = 10): Entity[] {
    const safe = sanitizeFtsQuery(query);
    if (!safe) return [];
    const rows = this.stmts.searchEntities.all(safe, limit) as EntityRow[];
    return rows.map(toEntity);
  }

  searchEntitiesRanked(
    query: string,
    limit = 10,
  ): Array<{ entity: Entity; ftsRank: number }> {
    const safe = sanitizeFtsQuery(query);
    if (!safe) return [];
    const rows = this.stmts.searchEntitiesRanked.all(safe, limit) as (EntityRow & {
      fts_rank: number;
    })[];
    return rows.map((row) => ({
      entity: toEntity(row),
      ftsRank: row.fts_rank,
    }));
  }

  getAllEntities(): Entity[] {
    const rows = this.stmts.getAllEntities.all() as EntityRow[];
    return rows.map(toEntity);
  }

  /** Batch entity lookup. Returns a Map for O(1) per-ID access. */
  getEntitiesByIds(ids: EntityId[]): Map<EntityId, Entity> {
    if (ids.length === 0) return new Map();

    const result = new Map<EntityId, Entity>();
    const unique = [...new Set(ids)];

    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT * FROM entities WHERE id IN (${placeholders})`)
        .all(...chunk) as EntityRow[];
      for (const row of rows) {
        result.set(row.id, toEntity(row));
      }
    }

    return result;
  }

  // ================================================================
  // Relations
  // ================================================================

  upsertRelation(relation: Relation): void {
    this.stmts.upsertRelation.run({
      id: relation.id,
      type: relation.type,
      sourceId: relation.sourceId,
      targetId: relation.targetId,
      weight: relation.weight,
      description: relation.description,
      evidence: JSON.stringify(relation.evidence),
      firstSeen: relation.firstSeen,
      lastSeen: relation.lastSeen,
    });
  }

  getRelation(id: RelationId): Relation | null {
    const row = this.stmts.getRelation.get(id) as RelationRow | undefined;
    return row ? toRelation(row) : null;
  }

  getRelationsBySource(sourceId: EntityId): Relation[] {
    const rows = this.stmts.getRelationsBySource.all(sourceId) as RelationRow[];
    return rows.map(toRelation);
  }

  getRelationsByTarget(targetId: EntityId): Relation[] {
    const rows = this.stmts.getRelationsByTarget.all(targetId) as RelationRow[];
    return rows.map(toRelation);
  }

  getAllRelations(): Relation[] {
    const rows = this.stmts.getAllRelations.all() as RelationRow[];
    return rows.map(toRelation);
  }

  // ================================================================
  // Text Units
  // ================================================================

  insertTextUnit(textUnit: TextUnit): void {
    this.stmts.insertTextUnit.run({
      id: textUnit.id,
      content: textUnit.content,
      commitHashes: JSON.stringify(textUnit.commitHashes),
      dateStart: textUnit.dateRange.start,
      dateEnd: textUnit.dateRange.end,
      entityIds: JSON.stringify(textUnit.entityIds),
      relationIds: JSON.stringify(textUnit.relationIds),
    });
    for (const entityId of textUnit.entityIds) {
      this.stmts.insertTextUnitEntity.run(textUnit.id, entityId, entityId);
    }
  }

  getTextUnit(id: TextUnitId): TextUnit | null {
    const row = this.stmts.getTextUnit.get(id) as TextUnitRow | undefined;
    return row ? toTextUnit(row) : null;
  }

  searchTextUnits(query: string, limit = 5): TextUnit[] {
    const safe = sanitizeFtsQuery(query);
    if (!safe) return [];
    const rows = this.stmts.searchTextUnits.all(safe, limit) as TextUnitRow[];
    return rows.map(toTextUnit);
  }

  // ================================================================
  // Communities
  // ================================================================

  upsertCommunity(community: Community): void {
    this.stmts.upsertCommunity.run({
      id: community.id,
      level: community.level,
      title: community.title,
      summary: community.summary,
      entityIds: JSON.stringify(community.entityIds),
      parentId: community.parentId ?? null,
      childIds: JSON.stringify(community.childIds),
    });
    this.stmts.deleteCommunityEntities.run(community.id);
    for (const entityId of community.entityIds) {
      this.stmts.insertCommunityEntity.run(community.id, entityId, entityId);
    }
  }

  getCommunity(id: CommunityId): Community | null {
    const row = this.stmts.getCommunity.get(id) as CommunityRow | undefined;
    return row ? toCommunity(row) : null;
  }

  getCommunitiesByLevel(level: number): Community[] {
    const rows = this.stmts.getCommunitiesByLevel.all(
      level,
    ) as CommunityRow[];
    return rows.map(toCommunity);
  }

  searchCommunities(query: string, limit = 5): Community[] {
    const safe = sanitizeFtsQuery(query);
    if (!safe) return [];
    const rows = this.stmts.searchCommunities.all(
      safe,
      limit,
    ) as CommunityRow[];
    return rows.map(toCommunity);
  }

  clearCommunities(): void {
    this.db.exec("DELETE FROM communities");
  }

  // ================================================================
  // Commits
  // ================================================================

  insertCommit(commit: CommitData, textUnitId: TextUnitId | null): void {
    this.stmts.insertCommit.run({
      hash: commit.hash,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      date: commit.date,
      message: commit.message,
      filesChanged: JSON.stringify(commit.filesChanged),
      parentHashes: JSON.stringify(commit.parentHashes),
      textUnitId,
      indexedAt: new Date().toISOString(),
    });
  }

  getCommit(hash: CommitHash): CommitData | null {
    const row = this.stmts.getCommit.get(hash) as CommitRow | undefined;
    return row ? toCommitData(row) : null;
  }

  getCommitCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM commits")
      .get() as { count: number };
    return row.count;
  }

  // ================================================================
  // Index Metadata
  // ================================================================

  setMeta(key: string, value: string): void {
    this.stmts.setMeta.run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.stmts.getMeta.get(key) as
      | { key: string; value: string }
      | undefined;
    return row?.value ?? null;
  }

  // ================================================================
  // Stats
  // ================================================================

  getStats(): StoreStats {
    const VALID_TABLES = new Set(["entities", "relations", "text_units", "communities", "commits"]);

    const count = (table: string) => {
      if (!VALID_TABLES.has(table)) throw new Error(`Invalid table name: ${table}`);
      return (
        this.db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as {
          c: number;
        }
      ).c;
    };

    return {
      entities: count("entities"),
      relations: count("relations"),
      textUnits: count("text_units"),
      communities: count("communities"),
      commits: count("commits"),
    };
  }

  // ================================================================
  // Graph traversal helpers (for query layer)
  // ================================================================

  /** Get all relations where entity is source OR target. */
  getRelationsForEntity(entityId: EntityId): Relation[] {
    return [
      ...this.getRelationsBySource(entityId),
      ...this.getRelationsByTarget(entityId),
    ];
  }

  /** Get text units that reference this entity (via JSON array search). */
  getTextUnitsForEntity(entityId: EntityId): TextUnit[] {
    const rows = this.stmts.textUnitsForEntity.all(entityId) as TextUnitRow[];
    return rows.map(toTextUnit);
  }

  /** Get communities that contain this entity (via JSON array search). */
  getCommunitiesForEntity(entityId: EntityId): Community[] {
    const rows = this.stmts.communitiesForEntity.all(
      entityId,
    ) as CommunityRow[];
    return rows.map(toCommunity);
  }

  /** Find MODULE entities matching a path (exact + prefix for sub-modules). */
  findModulesByPath(modulePath: string): Entity[] {
    const rows = this.stmts.findModulesByPath.all(
      modulePath,
      modulePath + "/%",
    ) as EntityRow[];
    return rows.map(toEntity);
  }

  /** Get entity by exact name (case-insensitive). */
  getEntityByName(name: string): Entity | null {
    const row = this.stmts.getEntityByName.get(name) as
      | EntityRow
      | undefined;
    return row ? toEntity(row) : null;
  }

  // ================================================================
  // Lifecycle
  // ================================================================

  close(): void {
    this.db.close();
  }
}

// ================================================================
// Prepared Statements
// ================================================================

function prepareStatements(db: Database.Database) {
  return {
    // --- Entities ---
    upsertEntity: db.prepare(`
      INSERT INTO entities (id, type, name, aliases, description, first_seen, last_seen, frequency, metadata)
      VALUES (@id, @type, @name, @aliases, @description, @firstSeen, @lastSeen, @frequency, @metadata)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        name = excluded.name,
        aliases = excluded.aliases,
        description = excluded.description,
        first_seen = MIN(entities.first_seen, excluded.first_seen),
        last_seen = MAX(entities.last_seen, excluded.last_seen),
        frequency = entities.frequency + excluded.frequency,
        metadata = excluded.metadata
    `),
    getEntity: db.prepare("SELECT * FROM entities WHERE id = ?"),
    getEntitiesByType: db.prepare("SELECT * FROM entities WHERE type = ?"),
    getAllEntities: db.prepare("SELECT * FROM entities"),
    searchEntities: db.prepare(`
      SELECT entities.* FROM entities_fts
      JOIN entities ON entities.rowid = entities_fts.rowid
      WHERE entities_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `),
    searchEntitiesRanked: db.prepare(`
      SELECT entities.*, bm25(entities_fts, 10.0, 5.0, 1.0) AS fts_rank
      FROM entities_fts
      JOIN entities ON entities.rowid = entities_fts.rowid
      WHERE entities_fts MATCH ?
      ORDER BY fts_rank
      LIMIT ?
    `),

    // --- Relations ---
    upsertRelation: db.prepare(`
      INSERT INTO relations (id, type, source_id, target_id, weight, description, evidence, first_seen, last_seen)
      VALUES (@id, @type, @sourceId, @targetId, @weight, @description, @evidence, @firstSeen, @lastSeen)
      ON CONFLICT(id) DO UPDATE SET
        weight = relations.weight + excluded.weight,
        description = excluded.description,
        evidence = excluded.evidence,
        first_seen = MIN(relations.first_seen, excluded.first_seen),
        last_seen = MAX(relations.last_seen, excluded.last_seen)
    `),
    getRelation: db.prepare("SELECT * FROM relations WHERE id = ?"),
    getRelationsBySource: db.prepare(
      "SELECT * FROM relations WHERE source_id = ?",
    ),
    getRelationsByTarget: db.prepare(
      "SELECT * FROM relations WHERE target_id = ?",
    ),
    getAllRelations: db.prepare("SELECT * FROM relations"),

    // --- Text Units ---
    insertTextUnit: db.prepare(`
      INSERT OR IGNORE INTO text_units (id, content, commit_hashes, date_start, date_end, entity_ids, relation_ids)
      VALUES (@id, @content, @commitHashes, @dateStart, @dateEnd, @entityIds, @relationIds)
    `),
    getTextUnit: db.prepare("SELECT * FROM text_units WHERE id = ?"),
    searchTextUnits: db.prepare(`
      SELECT text_units.* FROM text_units_fts
      JOIN text_units ON text_units.rowid = text_units_fts.rowid
      WHERE text_units_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `),

    // --- Communities ---
    upsertCommunity: db.prepare(`
      INSERT INTO communities (id, level, title, summary, entity_ids, parent_id, child_ids)
      VALUES (@id, @level, @title, @summary, @entityIds, @parentId, @childIds)
      ON CONFLICT(id) DO UPDATE SET
        level = excluded.level,
        title = excluded.title,
        summary = excluded.summary,
        entity_ids = excluded.entity_ids,
        parent_id = excluded.parent_id,
        child_ids = excluded.child_ids
    `),
    getCommunity: db.prepare("SELECT * FROM communities WHERE id = ?"),
    getCommunitiesByLevel: db.prepare(
      "SELECT * FROM communities WHERE level = ?",
    ),
    searchCommunities: db.prepare(`
      SELECT communities.* FROM communities_fts
      JOIN communities ON communities.rowid = communities_fts.rowid
      WHERE communities_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `),

    // --- Commits ---
    insertCommit: db.prepare(`
      INSERT OR IGNORE INTO commits (hash, author_name, author_email, date, message, files_changed, parent_hashes, text_unit_id, indexed_at)
      VALUES (@hash, @authorName, @authorEmail, @date, @message, @filesChanged, @parentHashes, @textUnitId, @indexedAt)
    `),
    getCommit: db.prepare("SELECT * FROM commits WHERE hash = ?"),

    // --- Meta ---
    setMeta: db.prepare(
      "INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)",
    ),
    getMeta: db.prepare("SELECT * FROM index_meta WHERE key = ?"),

    // --- Junction table operations ---
    insertTextUnitEntity: db.prepare(
      "INSERT OR IGNORE INTO text_unit_entities(text_unit_id, entity_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM entities WHERE id = ?)"
    ),
    deleteCommunityEntities: db.prepare(
      "DELETE FROM community_entities WHERE community_id = ?"
    ),
    insertCommunityEntity: db.prepare(
      "INSERT OR IGNORE INTO community_entities(community_id, entity_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM entities WHERE id = ?)"
    ),

    // --- Query helpers ---
    textUnitsForEntity: db.prepare(`
      SELECT t.* FROM text_unit_entities tue
      JOIN text_units t ON t.id = tue.text_unit_id
      WHERE tue.entity_id = ?
    `),
    communitiesForEntity: db.prepare(`
      SELECT c.* FROM community_entities ce
      JOIN communities c ON c.id = ce.community_id
      WHERE ce.entity_id = ?
    `),
    findModulesByPath: db.prepare(`
      SELECT * FROM entities
      WHERE type = 'MODULE' AND (name = ? OR name LIKE ?)
    `),
    getEntityByName: db.prepare(
      "SELECT * FROM entities WHERE name = ? COLLATE NOCASE",
    ),
  };
}

// ================================================================
// FTS5 Query Sanitization
// ================================================================

/**
 * Sanitize user input for FTS5 MATCH queries.
 *
 * Improvements over naive tokenization:
 * - Splits camelCase/PascalCase ("PaymentGateway" → ["Payment", "Gateway"])
 * - Prefix matching for short tokens (< 6 chars) to handle abbreviations
 * - Stop word removal for conversational filler
 */
function sanitizeFtsQuery(query: string): string | null {
  let tokens = query
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);

  // Split camelCase/PascalCase: "PaymentGateway" → ["PaymentGateway", "Payment", "Gateway"]
  // Keep original alongside splits so "gRPC" → ["gRPC", "g", "RPC"] → after filter → ["gRPC", "RPC"]
  tokens = [
    ...new Set(
      tokens.flatMap((t) => {
        const parts = t.split(
          /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/,
        );
        return parts.length > 1 ? [t, ...parts] : parts;
      }),
    ),
  ];

  tokens = tokens
    .filter((t) => t.length > 1)
    .filter((t) => !STOP_WORDS.has(t.toLowerCase()));

  if (tokens.length === 0) return null;

  // Short tokens get prefix matching (auth → auth*), longer ones get exact match
  return tokens
    .map((t) => (t.length < 6 ? `${t}*` : `"${t}"`))
    .join(" OR ");
}

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall",
  "i", "me", "my", "we", "our", "you", "your",
  "he", "she", "it", "they", "them", "their",
  "this", "that", "these", "those",
  "who", "what", "where", "when", "why", "how",
  "not", "no", "nor", "but", "or", "and",
  "if", "then", "than", "so", "as",
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "about",
]);

// ================================================================
// Row → Domain Mappers
// ================================================================

interface EntityRow {
  id: string;
  type: string;
  name: string;
  aliases: string;
  description: string;
  first_seen: string;
  last_seen: string;
  frequency: number;
  metadata: string;
}

interface RelationRow {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
  weight: number;
  description: string;
  evidence: string;
  first_seen: string;
  last_seen: string;
}

interface TextUnitRow {
  id: string;
  content: string;
  commit_hashes: string;
  date_start: string;
  date_end: string;
  entity_ids: string;
  relation_ids: string;
}

interface CommunityRow {
  id: string;
  level: number;
  title: string;
  summary: string;
  entity_ids: string;
  parent_id: string | null;
  child_ids: string;
}

interface CommitRow {
  hash: string;
  author_name: string;
  author_email: string;
  date: string;
  message: string;
  files_changed: string;
  parent_hashes: string;
  text_unit_id: string | null;
  indexed_at: string;
}

function toEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    type: row.type as Entity["type"],
    name: row.name,
    aliases: JSON.parse(row.aliases),
    description: row.description,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    frequency: row.frequency,
    metadata: JSON.parse(row.metadata),
  };
}

function toRelation(row: RelationRow): Relation {
  return {
    id: row.id,
    type: row.type as Relation["type"],
    sourceId: row.source_id,
    targetId: row.target_id,
    weight: row.weight,
    description: row.description,
    evidence: JSON.parse(row.evidence),
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  };
}

function toTextUnit(row: TextUnitRow): TextUnit {
  return {
    id: row.id,
    content: row.content,
    commitHashes: JSON.parse(row.commit_hashes),
    dateRange: { start: row.date_start, end: row.date_end },
    entityIds: JSON.parse(row.entity_ids),
    relationIds: JSON.parse(row.relation_ids),
  };
}

function toCommunity(row: CommunityRow): Community {
  return {
    id: row.id,
    level: row.level,
    title: row.title,
    summary: row.summary,
    entityIds: JSON.parse(row.entity_ids),
    parentId: row.parent_id ?? undefined,
    childIds: JSON.parse(row.child_ids),
  };
}

function toCommitData(row: CommitRow): CommitData {
  return {
    hash: row.hash,
    authorName: row.author_name,
    authorEmail: row.author_email,
    date: row.date,
    message: row.message,
    filesChanged: JSON.parse(row.files_changed),
    parentHashes: JSON.parse(row.parent_hashes),
  };
}
