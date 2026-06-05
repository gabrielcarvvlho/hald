import { createHash } from "node:crypto";
import type { Store } from "../store/queries.js";
import {
  RelationType,
  type Entity,
  type Relation,
  type TextUnit,
  type CommitData,
  type RelationId,
} from "../shared/types.js";
import type { ExtractorResult } from "./extractor.js";
import { normalizeModulePath, generateEntityId } from "./resolver.js";
import { EntityType } from "../shared/types.js";
import { logger } from "../shared/logger.js";

export interface GraphStats {
  entityCount: number;
  relationCount: number;
  textUnitCount: number;
  edgeDensity: number;
}

export interface BuildInput {
  textUnits: TextUnit[];
  entities: Entity[];
  relations: Relation[];
  /** Mapping from textUnitId → extraction result (for linking entities to text units) */
  extractions: Map<string, ExtractorResult>;
  /** Original commits for co-change edge creation */
  commits: CommitData[];
  /** Module path normalization depth (passed through from config) */
  moduleDepth?: number;
}

/**
 * Upsert resolved entities, relations, text units, and commits into the store.
 * Also creates co-change edges from commits.
 */
export function build(store: Store, input: BuildInput): GraphStats {
  const end = logger.time("graph-builder: build");

  // Deterministic ownership layer (PERSON + MODULE entities, PERSON→MODULE
  // AUTHORED/MODIFIED edges) derived purely from commit authorship.
  const ownership = buildOwnershipGraph(input.commits, input.moduleDepth);

  store.transaction(() => {
    // 1a. Upsert deterministic ownership entities FIRST. They carry empty
    // descriptions, so upserting before the LLM entities lets any richer
    // LLM description win the ON CONFLICT (last write), while frequency merges
    // additively. They also guarantee every ownership edge has a valid target.
    for (const entity of ownership.entities) {
      store.upsertEntity(entity);
    }

    // 1b. Upsert LLM-extracted entities (with dates from text units).
    // Build lookup that handles both canonical names and normalized paths
    const entityMap = new Map<string, Entity>();
    for (const e of input.entities) {
      entityMap.set(e.name.toLowerCase(), e);
      for (const alias of e.aliases) {
        entityMap.set(alias.toLowerCase(), e);
      }
    }

    for (const tu of input.textUnits) {
      const extraction = input.extractions.get(tu.id);
      if (!extraction) continue;

      for (const extracted of extraction.entities) {
        const entity =
          entityMap.get(extracted.name.toLowerCase()) ??
          entityMap.get(normalizeModulePath(extracted.name, input.moduleDepth).toLowerCase());
        if (!entity) continue;

        store.upsertEntity({
          ...entity,
          firstSeen: tu.dateRange.start,
          lastSeen: tu.dateRange.end,
          frequency: 1,
        });
      }
    }

    // Pre-fetch entity existence for FK validation (batch instead of per-relation lookup)
    const coChangeRelations = buildCoChangeEdges(input.commits, input.moduleDepth);

    const relationEntityIds = new Set<string>();
    for (const relation of input.relations) {
      relationEntityIds.add(relation.sourceId);
      relationEntityIds.add(relation.targetId);
    }
    for (const rel of coChangeRelations) {
      relationEntityIds.add(rel.sourceId);
      relationEntityIds.add(rel.targetId);
    }
    for (const rel of ownership.relations) {
      relationEntityIds.add(rel.sourceId);
      relationEntityIds.add(rel.targetId);
    }
    const existingEntities = store.getEntitiesByIds([...relationEntityIds]);

    // 2. Upsert relations (use pre-fetched map instead of per-relation getEntity)
    for (const relation of input.relations) {
      if (existingEntities.has(relation.sourceId) && existingEntities.has(relation.targetId)) {
        store.upsertRelation(relation);
      } else {
        logger.debug("graph-builder: skipping relation, missing entity", {
          id: relation.id,
          sourceId: relation.sourceId,
          targetId: relation.targetId,
        });
      }
    }

    // 3. Insert text units
    for (const tu of input.textUnits) {
      store.insertTextUnit(tu);
    }

    // 4. Insert commits
    const commitToTextUnit = buildCommitTextUnitMap(input.textUnits);
    for (const commit of input.commits) {
      store.insertCommit(commit, commitToTextUnit.get(commit.hash) ?? null);
    }

    // 5. Create co-change edges (use pre-fetched map)
    for (const rel of coChangeRelations) {
      if (existingEntities.has(rel.sourceId) && existingEntities.has(rel.targetId)) {
        store.upsertRelation(rel);
      }
    }

    // 6. Create deterministic ownership edges (use pre-fetched map).
    for (const rel of ownership.relations) {
      if (existingEntities.has(rel.sourceId) && existingEntities.has(rel.targetId)) {
        store.upsertRelation(rel);
      }
    }
  });

  const stats = store.getStats();

  end();
  logger.info("graph-builder: done", { ...stats });

  return {
    entityCount: stats.entities,
    relationCount: stats.relations,
    textUnitCount: stats.textUnits,
    edgeDensity: stats.entities > 1 ? stats.relations / (stats.entities * (stats.entities - 1)) : 0,
  };
}

// ================================================================
// Deterministic ownership layer (PERSON + AUTHORED/MODIFIED edges)
// ================================================================

/**
 * The headline "connections" layer: derive PERSON entities and
 * PERSON→MODULE ownership edges deterministically from commit authorship,
 * independent of any LLM extraction.
 *
 * Without this, PERSON entities and AUTHORED/MODIFIED edges only exist when the
 * LLM happens to emit them — making "who knows module X?" sparse and unreliable.
 * Here, every distinct author becomes a PERSON entity and every (author, module)
 * touch becomes an ownership edge, so the graph always answers ownership queries
 * from ground-truth git history.
 *
 * Edge typing (consistent with shared/types RelationType + RELATION_CONSTRAINTS,
 * where AUTHORED/MODIFIED are both PERSON→MODULE):
 *   - AUTHORED: the author added a file under the module (introduced/owns it).
 *   - MODIFIED: the author only changed pre-existing files in the module.
 * A module the author both added and later modified resolves to AUTHORED (the
 * stronger ownership signal).
 *
 * IDs use the shared generate*Id helpers so any LLM-emitted PERSON/MODULE
 * entities or AUTHORED/MODIFIED relations collide-and-merge via ON CONFLICT
 * upsert rather than duplicating.
 */
interface OwnershipGraph {
  entities: Entity[];
  relations: Relation[];
}

interface AuthorAccumulator {
  name: string;
  commitCount: number;
  firstSeen: string;
  lastSeen: string;
}

interface OwnershipEdgeAccumulator {
  personId: string;
  moduleId: string;
  /** True once any commit ADDED a file in this module (→ AUTHORED). */
  authored: boolean;
  /** Accumulated lines changed across all touching commits. */
  lines: number;
  commitCount: number;
  firstSeen: string;
  lastSeen: string;
}

interface ModuleAccumulator {
  name: string;
  firstSeen: string;
  lastSeen: string;
  touches: number;
}

export function buildOwnershipGraph(commits: CommitData[], moduleDepth?: number): OwnershipGraph {
  // Canonicalize authors by email (a person may spell their name differently
  // across commits but the email is the stable identity). The display name is
  // the most recent non-empty name seen for that email.
  const authorByEmail = new Map<string, AuthorAccumulator>();
  const edges = new Map<string, OwnershipEdgeAccumulator>();
  // Modules touched by these commits. We emit them as MODULE entities so the
  // ownership edges always have a valid target (the LLM may not have extracted
  // every module), making ownership queries reliable rather than LLM-dependent.
  const modulesByName = new Map<string, ModuleAccumulator>();

  for (const commit of commits) {
    // Skip merge commits — their file lists duplicate the merged branch commits,
    // which would double-count ownership (mirrors the co-change builder).
    if (commit.parentHashes.length > 1) continue;

    const email = commit.authorEmail.trim().toLowerCase();
    const name = commit.authorName.trim();
    if (!email && !name) continue;

    // Identity key: prefer email; fall back to name when email is missing.
    const identityKey = email || `name:${name.toLowerCase()}`;
    const author = authorByEmail.get(identityKey);
    if (!author) {
      authorByEmail.set(identityKey, {
        name: name || email,
        commitCount: 1,
        firstSeen: commit.date,
        lastSeen: commit.date,
      });
    } else {
      author.commitCount++;
      if (name) author.name = name;
      if (commit.date < author.firstSeen) author.firstSeen = commit.date;
      if (commit.date > author.lastSeen) author.lastSeen = commit.date;
    }

    const resolvedName = authorByEmail.get(identityKey)!.name;
    const personId = generateEntityId(EntityType.PERSON, resolvedName);

    // Aggregate per-module ownership signal for this commit (one edge per module
    // the author touched, with the strongest status across the commit's files).
    const moduleStatus = new Map<string, { added: boolean; lines: number }>();
    for (const f of commit.filesChanged) {
      const mod = normalizeModulePath(f.path, moduleDepth);
      const lines = (f.additions || 0) + (f.deletions || 0);
      const entry = moduleStatus.get(mod) ?? { added: false, lines: 0 };
      entry.added = entry.added || f.status === "added";
      entry.lines += lines;
      moduleStatus.set(mod, entry);

      const moduleAcc = modulesByName.get(mod);
      if (!moduleAcc) {
        modulesByName.set(mod, {
          name: mod,
          firstSeen: commit.date,
          lastSeen: commit.date,
          touches: 1,
        });
      } else {
        moduleAcc.touches++;
        if (commit.date < moduleAcc.firstSeen) moduleAcc.firstSeen = commit.date;
        if (commit.date > moduleAcc.lastSeen) moduleAcc.lastSeen = commit.date;
      }
    }

    for (const [mod, status] of moduleStatus) {
      const moduleId = generateEntityId(EntityType.MODULE, mod);
      const edgeKey = `${personId} ${moduleId}`;
      const edge = edges.get(edgeKey);
      if (!edge) {
        edges.set(edgeKey, {
          personId,
          moduleId,
          authored: status.added,
          lines: status.lines,
          commitCount: 1,
          firstSeen: commit.date,
          lastSeen: commit.date,
        });
      } else {
        edge.authored = edge.authored || status.added;
        edge.lines += status.lines;
        edge.commitCount++;
        if (commit.date < edge.firstSeen) edge.firstSeen = commit.date;
        if (commit.date > edge.lastSeen) edge.lastSeen = commit.date;
      }
    }
  }

  const entities: Entity[] = [];
  for (const author of authorByEmail.values()) {
    entities.push({
      id: generateEntityId(EntityType.PERSON, author.name),
      type: EntityType.PERSON,
      name: author.name,
      aliases: [],
      description: "",
      firstSeen: author.firstSeen,
      lastSeen: author.lastSeen,
      // frequency = commits authored, so the ON CONFLICT additive merge keeps
      // this person's weight consistent with LLM-emitted PERSON entities.
      frequency: author.commitCount,
      metadata: {},
    });
  }

  for (const mod of modulesByName.values()) {
    entities.push({
      id: generateEntityId(EntityType.MODULE, mod.name),
      type: EntityType.MODULE,
      name: mod.name,
      aliases: [],
      description: "",
      firstSeen: mod.firstSeen,
      lastSeen: mod.lastSeen,
      // frequency = number of times this module was touched. The additive ON
      // CONFLICT merge folds this into any LLM-emitted MODULE of the same id.
      frequency: mod.touches,
      metadata: {},
    });
  }

  const relations: Relation[] = [];
  for (const edge of edges.values()) {
    if (edge.personId === edge.moduleId) continue; // defensive: never a self-loop
    const type = edge.authored ? RelationType.AUTHORED : RelationType.MODIFIED;
    const id = generateRelationId(type, edge.personId, edge.moduleId);
    // Weight by commit count + lines touched — a person who repeatedly edits a
    // module, or moves a lot of lines, owns it more strongly.
    const weight = edge.commitCount + Math.min(edge.lines, 100);
    relations.push({
      id,
      type,
      sourceId: edge.personId,
      targetId: edge.moduleId,
      weight,
      description: edge.authored
        ? `Authored across ${edge.commitCount} commit(s)`
        : `Modified across ${edge.commitCount} commit(s)`,
      evidence: [],
      firstSeen: edge.firstSeen,
      lastSeen: edge.lastSeen,
    });
  }

  return { entities, relations };
}

// ================================================================
// Co-change edges
// ================================================================

function buildCoChangeEdges(commits: CommitData[], moduleDepth?: number): Relation[] {
  const relations: Relation[] = [];

  for (const commit of commits) {
    // Skip merge commits — their file lists duplicate the merged branch commits
    if (commit.parentHashes.length > 1) continue;

    // Aggregate lines changed per module (after path normalization)
    const moduleLinesMap = new Map<string, number>();
    for (const f of commit.filesChanged) {
      const mod = normalizeModulePath(f.path, moduleDepth);
      const lines = (f.additions || 0) + (f.deletions || 0);
      moduleLinesMap.set(mod, (moduleLinesMap.get(mod) ?? 0) + lines);
    }

    const modules = [...moduleLinesMap.keys()];

    // Create edges for pairs of modules changed in the same commit
    for (let i = 0; i < modules.length; i++) {
      for (let j = i + 1; j < modules.length; j++) {
        const sourceId = generateEntityId(EntityType.MODULE, modules[i]!);
        const targetId = generateEntityId(EntityType.MODULE, modules[j]!);

        // Skip self-loops (same directory after normalization)
        if (sourceId === targetId) continue;

        const id = generateRelationId(RelationType.CO_CHANGED, sourceId, targetId);

        // Weight by min lines changed — proportional to shared commit significance
        const linesA = moduleLinesMap.get(modules[i]!) ?? 0;
        const linesB = moduleLinesMap.get(modules[j]!) ?? 0;
        const weight = Math.min(linesA, linesB) || 1;

        relations.push({
          id,
          type: RelationType.CO_CHANGED,
          sourceId,
          targetId,
          weight,
          description: `Changed together in commit ${commit.hash.slice(0, 7)}`,
          evidence: [],
          firstSeen: commit.date,
          lastSeen: commit.date,
        });
      }
    }
  }

  return relations;
}

// ================================================================
// Helpers
// ================================================================

function buildCommitTextUnitMap(textUnits: TextUnit[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const tu of textUnits) {
    for (const hash of tu.commitHashes) {
      map.set(hash, tu.id);
    }
  }
  return map;
}

export function generateRelationId(
  type: RelationType,
  sourceId: string,
  targetId: string,
): RelationId {
  // Sort to make id deterministic regardless of direction
  const [a, b] = [sourceId, targetId].sort();
  const hash = createHash("sha256").update(`${type}:${a}:${b}`).digest("hex").slice(0, 8);
  return `rel:${hash}`;
}
