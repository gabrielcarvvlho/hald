import { createHash } from "node:crypto";
import {
  EntityType,
  type Entity,
  type EntityId,
} from "../shared/types.js";
import type { ExtractedEntity } from "./extractor.js";

/**
 * Deduplicate extracted entities. Groups by identity (same type + similar name),
 * merges descriptions, and assigns canonical IDs + aliases.
 *
 * Temporal data (firstSeen/lastSeen/frequency) is set to defaults here —
 * the graph builder updates them when upserting with text unit context.
 */
export function resolve(
  entities: ExtractedEntity[],
  threshold: number,
): Entity[] {
  const byType = groupBy(entities, (e) => e.type as string);
  const resolved: Entity[] = [];

  for (const [typeStr, group] of byType) {
    const type = typeStr as EntityType;
    if (type === EntityType.PERSON) {
      resolved.push(...resolveGroup(group, type, threshold));
    } else if (type === EntityType.MODULE) {
      const normalized = group.map((e) => ({
        ...e,
        name: normalizeModulePath(e.name),
      }));
      resolved.push(...resolveGroup(normalized, type, threshold));
    } else {
      resolved.push(...resolveGroup(group, type, threshold));
    }
  }

  return resolved;
}

// ================================================================
// Group resolution
// ================================================================

function resolveGroup(
  entities: ExtractedEntity[],
  type: EntityType,
  threshold: number,
): Entity[] {
  const clusters: ExtractedEntity[][] = [];

  for (const entity of entities) {
    const key = entity.name.toLowerCase().trim();
    let merged = false;

    for (const cluster of clusters) {
      const clusterKey = cluster[0]!.name.toLowerCase().trim();
      if (
        key === clusterKey ||
        jaroWinkler(key, clusterKey) >= threshold
      ) {
        cluster.push(entity);
        merged = true;
        break;
      }
    }

    if (!merged) {
      clusters.push([entity]);
    }
  }

  return clusters.map((cluster) => mergeCluster(cluster, type));
}

function mergeCluster(cluster: ExtractedEntity[], type: EntityType): Entity {
  // Pick the most common or longest name as canonical
  const nameFreq = new Map<string, number>();
  for (const e of cluster) {
    const n = e.name.trim();
    nameFreq.set(n, (nameFreq.get(n) ?? 0) + 1);
  }
  const canonicalName = [...nameFreq.entries()].sort(
    (a, b) => b[1] - a[1] || b[0].length - a[0].length,
  )[0]![0];

  // Collect unique aliases (all name variants except canonical)
  const aliases = [
    ...new Set(
      cluster
        .map((e) => e.name.trim())
        .filter((n) => n !== canonicalName),
    ),
  ];

  // Pick the longest description
  const description = cluster
    .map((e) => e.description)
    .sort((a, b) => b.length - a.length)[0] ?? "";

  const id = generateEntityId(type, canonicalName);

  return {
    id,
    type,
    name: canonicalName,
    aliases,
    description,
    firstSeen: "",
    lastSeen: "",
    frequency: 0,
    metadata: {},
  };
}

// ================================================================
// Entity ID generation
// ================================================================

export function generateEntityId(type: EntityType, name: string): EntityId {
  const prefix = type.toLowerCase();
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9/_.-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${prefix}:${slug}`;
}

// ================================================================
// Module path normalization
// ================================================================

export function normalizeModulePath(filePath: string): string {
  // Strip index files: src/billing/index.ts → src/billing
  let normalized = filePath.replace(/\/index\.[^/]+$/, "");

  // For deeper paths, group to directory: src/billing/processor.ts → src/billing
  if (/\.[a-z]+$/i.test(normalized)) {
    const parts = normalized.split("/");
    if (parts.length >= 3) {
      normalized = parts.slice(0, -1).join("/");
    }
  }

  return normalized;
}

// ================================================================
// Jaro-Winkler similarity (inline implementation)
// ================================================================

export function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);

  const s1Matches = new Array<boolean>(s1.length).fill(false);
  const s2Matches = new Array<boolean>(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  // Find matches
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, s2.length);

    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro =
    (matches / s1.length +
      matches / s2.length +
      (matches - transpositions / 2) / matches) /
    3;

  // Winkler modification: boost for common prefix (up to 4 chars)
  let prefixLen = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefixLen++;
    else break;
  }

  return jaro + prefixLen * 0.1 * (1 - jaro);
}

// ================================================================
// Helpers
// ================================================================

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = map.get(key) ?? [];
    group.push(item);
    map.set(key, group);
  }
  return map;
}
