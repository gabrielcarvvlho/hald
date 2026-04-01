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

  store.transaction(() => {
    // 1. Upsert entities (with dates from text units)
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
  });

  const stats = store.getStats();

  end();
  logger.info("graph-builder: done", { ...stats });

  return {
    entityCount: stats.entities,
    relationCount: stats.relations,
    textUnitCount: stats.textUnits,
    edgeDensity:
      stats.entities > 1
        ? stats.relations / (stats.entities * (stats.entities - 1))
        : 0,
  };
}

// ================================================================
// Co-change edges
// ================================================================

function buildCoChangeEdges(commits: CommitData[], moduleDepth?: number): Relation[] {
  const relations: Relation[] = [];

  for (const commit of commits) {
    // Skip merge commits — their file lists duplicate the merged branch commits
    if (commit.parentHashes.length > 1) continue;
    const modules = [
      ...new Set(
        commit.filesChanged.map((f) =>
          normalizeModulePath(f.path, moduleDepth),
        ),
      ),
    ];

    // Create edges for pairs of modules changed in the same commit
    for (let i = 0; i < modules.length; i++) {
      for (let j = i + 1; j < modules.length; j++) {
        const sourceId = generateEntityId(EntityType.MODULE, modules[i]!);
        const targetId = generateEntityId(EntityType.MODULE, modules[j]!);

        // Skip self-loops (same directory after normalization)
        if (sourceId === targetId) continue;

        const id = generateRelationId(
          RelationType.CO_CHANGED,
          sourceId,
          targetId,
        );

        relations.push({
          id,
          type: RelationType.CO_CHANGED,
          sourceId,
          targetId,
          weight: 1,
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

function buildCommitTextUnitMap(
  textUnits: TextUnit[],
): Map<string, string> {
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
  const hash = createHash("sha256")
    .update(`${type}:${a}:${b}`)
    .digest("hex")
    .slice(0, 8);
  return `rel:${hash}`;
}
