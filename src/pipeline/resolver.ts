import { EntityType, type Entity, type EntityId } from "../shared/types.js";
import type { ExtractedEntity } from "./extractor.js";

export interface ResolveOptions {
  threshold: number;
  /** Module path normalization depth (number of path segments to keep). Default: 2 */
  moduleDepth?: number;
}

/**
 * Deduplicate extracted entities. Groups by identity (same type + similar name),
 * merges descriptions, and assigns canonical IDs + aliases.
 *
 * Strategies (applied in order):
 * 1. Exact match (case-insensitive)
 * 2. Alias/abbreviation match (known tech abbreviations)
 * 3. Fuzzy match (Jaro-Winkler above threshold)
 * 4. Module path normalization (configurable depth)
 *
 * Input is sorted deterministically before clustering to guarantee
 * the same input always produces the same output.
 */
export function resolve(
  entities: ExtractedEntity[],
  thresholdOrOptions: number | ResolveOptions,
): Entity[] {
  const opts: ResolveOptions =
    typeof thresholdOrOptions === "number" ? { threshold: thresholdOrOptions } : thresholdOrOptions;

  const byType = groupBy(entities, (e) => e.type as string);
  const resolved: Entity[] = [];

  for (const [typeStr, group] of byType) {
    const type = typeStr as EntityType;
    if (type === EntityType.MODULE) {
      const normalized = group.map((e) => ({
        ...e,
        name: normalizeModulePath(e.name, opts.moduleDepth),
      }));
      resolved.push(...resolveGroup(normalized, type, opts.threshold));
    } else {
      resolved.push(...resolveGroup(group, type, opts.threshold));
    }
  }

  return resolved;
}

// ================================================================
// Known abbreviations (bidirectional lookup)
// ================================================================

const ABBREVIATIONS: ReadonlyMap<string, string> = new Map([
  ["ts", "typescript"],
  ["js", "javascript"],
  ["py", "python"],
  ["rb", "ruby"],
  ["k8s", "kubernetes"],
  ["pg", "postgresql"],
  ["postgres", "postgresql"],
  ["mongo", "mongodb"],
  ["es", "elasticsearch"],
  ["tf", "terraform"],
  ["gh", "github"],
  ["gl", "gitlab"],
  ["gql", "graphql"],
  ["node", "node.js"],
  ["react.js", "react"],
  ["reactjs", "react"],
  ["vue.js", "vue"],
  ["vuejs", "vue"],
  ["next.js", "nextjs"],
  ["express.js", "express"],
  ["nuxt.js", "nuxt"],
  ["svelte.js", "svelte"],
]);

/**
 * Expand a name to its canonical form using the abbreviation table.
 * Returns the canonical name if found, otherwise the original.
 */
function expandAbbreviation(name: string): string {
  const lower = name.toLowerCase();
  return ABBREVIATIONS.get(lower) ?? lower;
}

/**
 * Check if two names are alias-equivalent via the abbreviation table.
 */
function isAliasMatch(a: string, b: string): boolean {
  return expandAbbreviation(a) === expandAbbreviation(b);
}

// ================================================================
// Group resolution
// ================================================================

function resolveGroup(entities: ExtractedEntity[], type: EntityType, threshold: number): Entity[] {
  // Sort deterministically: by lowercased name, then by description length (descending),
  // then by description content (code-point order). This guarantees the same input
  // always produces the same clusters regardless of extraction order from concurrent LLM calls.
  const sorted = [...entities].sort((a, b) => {
    const na = a.name.toLowerCase().trim();
    const nb = b.name.toLowerCase().trim();
    if (na < nb) return -1;
    if (na > nb) return 1;
    const dlen = b.description.length - a.description.length;
    if (dlen !== 0) return dlen;
    // Final tiebreaker: description content (code-point, not locale-dependent)
    if (a.description < b.description) return -1;
    if (a.description > b.description) return 1;
    return 0;
  });

  const clusters: ExtractedEntity[][] = [];
  // Track the expanded (abbreviation-resolved) key for each cluster head
  const clusterExpandedKeys: string[] = [];

  for (const entity of sorted) {
    const key = entity.name.toLowerCase().trim();
    const expandedKey = expandAbbreviation(key);
    let merged = false;

    for (let ci = 0; ci < clusters.length; ci++) {
      const clusterKey = clusters[ci]![0]!.name.toLowerCase().trim();
      const clusterExpanded = clusterExpandedKeys[ci]!;

      // Strategy 1: Exact match (case-insensitive, after trim)
      if (key === clusterKey) {
        clusters[ci]!.push(entity);
        merged = true;
        break;
      }

      // Strategy 2: Alias/abbreviation match
      if (expandedKey === clusterExpanded) {
        clusters[ci]!.push(entity);
        merged = true;
        break;
      }

      // Strategy 3: Fuzzy match with prefix blocking
      // Skip JW if length difference is too large (> 50% of the longer string)
      // or if strings share no common prefix — these can't score above typical thresholds.
      //
      // MODULE entities are EXEMPT: paths are structured, not fuzzy. Sibling
      // paths share the same parent prefix ("src/auth" vs "src/api"), and the
      // Winkler prefix boost pushes them above the threshold (JW≈0.87), so
      // fuzzy matching collapses distinct modules. Path normalization in
      // resolve() already groups truly-equivalent paths via exact match, so
      // MODULE relies solely on exact + alias matching here.
      if (
        type !== EntityType.MODULE &&
        canFuzzyMatch(key, clusterKey) &&
        jaroWinkler(key, clusterKey) >= threshold
      ) {
        clusters[ci]!.push(entity);
        merged = true;
        break;
      }
    }

    if (!merged) {
      clusters.push([entity]);
      clusterExpandedKeys.push(expandedKey);
    }
  }

  return clusters.map((cluster) => mergeCluster(cluster, type));
}

/**
 * Cheap pre-filter: skip Jaro-Winkler for pairs that can't possibly score above ~0.85.
 * Length ratio < 0.5 → max JW score is well below 0.85.
 */
function canFuzzyMatch(a: string, b: string): boolean {
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0 || lenB === 0) return false;

  // Length ratio check
  const ratio = Math.min(lenA, lenB) / Math.max(lenA, lenB);
  if (ratio < 0.5) return false;

  return true;
}

function mergeCluster(cluster: ExtractedEntity[], type: EntityType): Entity {
  // Pick the most common name as canonical.
  // Tiebreaker 1: longer name (prefer "TypeScript" over "TS").
  // Tiebreaker 2: lexicographic order (determinism guarantee).
  const nameFreq = new Map<string, number>();
  for (const e of cluster) {
    const n = e.name.trim();
    nameFreq.set(n, (nameFreq.get(n) ?? 0) + 1);
  }
  const canonicalName = [...nameFreq.entries()].sort(
    (a, b) =>
      b[1] - a[1] || // most frequent first
      b[0].length - a[0].length || // longest first
      (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0), // code-point tiebreaker (locale-independent)
  )[0]![0];

  // Collect unique aliases (all name variants except canonical)
  const aliases = [
    ...new Set(cluster.map((e) => e.name.trim()).filter((n) => n !== canonicalName)),
  ].sort(); // Sort for determinism

  // Pick the longest description; tiebreaker on content for determinism
  const description =
    cluster
      .map((e) => e.description)
      .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))[0] ?? "";

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

/**
 * Normalize a file path to a module-level identifier.
 *
 * @param filePath - Raw file path (e.g., "src/billing/processor.ts")
 * @param depth - Number of path segments to keep (default: 2).
 *   depth=2: "src/billing/processor.ts" → "src/billing"
 *   depth=3: "src/api/routes/auth.ts" → "src/api/routes"
 *   depth=undefined: auto (strip file, keep directory)
 */
export function normalizeModulePath(filePath: string, depth?: number): string {
  // Strip index files: src/billing/index.ts → src/billing
  let normalized = filePath.replace(/\/index\.[^/]+$/, "");

  // If no file extension, it's already a directory-level path
  if (!/\.[a-z]+$/i.test(normalized)) {
    return applyDepth(normalized, depth);
  }

  // Strip the filename to get the directory
  const parts = normalized.split("/");
  if (parts.length >= 3) {
    normalized = parts.slice(0, -1).join("/");
  }
  // For shallow paths (< 3 parts), keep as-is (e.g., "src/cli.ts" stays)
  // since stripping would lose too much info

  return applyDepth(normalized, depth);
}

/**
 * If depth is set, truncate the path to that many segments.
 * "src/api/routes" with depth=2 becomes "src/api".
 */
function applyDepth(path: string, depth?: number): string {
  if (depth == null) return path;
  const parts = path.split("/");
  if (parts.length <= depth) return path;
  return parts.slice(0, depth).join("/");
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
    (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;

  // Winkler modification: boost for common prefix (up to 4 chars)
  let prefixLen = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefixLen++;
    else break;
  }

  return jaro + prefixLen * 0.1 * (1 - jaro);
}

// ================================================================
// Exported helpers for alias matching
// ================================================================

export { isAliasMatch, expandAbbreviation, ABBREVIATIONS };

// ================================================================
// Internal helpers
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
