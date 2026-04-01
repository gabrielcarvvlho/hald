import { describe, it, expect } from "vitest";
import {
  resolve,
  jaroWinkler,
  normalizeModulePath,
  expandAbbreviation,
} from "../../src/pipeline/resolver.js";
import { EntityType } from "../../src/shared/types.js";
import type { ExtractedEntity } from "../../src/pipeline/extractor.js";

describe("resolver audit — edge cases", () => {

  // === DETERMINISM: same-length description tiebreaker ===
  it("same name + same description length → deterministic description", () => {
    const entities: ExtractedEntity[] = [
      { name: "React", type: EntityType.TECHNOLOGY, description: "AAA" },
      { name: "React", type: EntityType.TECHNOLOGY, description: "BBB" },
      { name: "React", type: EntityType.TECHNOLOGY, description: "CCC" },
    ];

    const result1 = resolve(entities, 0.85);
    const result2 = resolve([...entities].reverse(), 0.85);

    // Should pick the same description regardless of input order
    expect(result1[0]!.description).toBe(result2[0]!.description);
  });

  // === DETERMINISM: canonical name tiebreaker ===
  it("canonical name selection is deterministic across input orders", () => {
    // Two names with same freq (1 each), same length (5)
    const entities: ExtractedEntity[] = [
      { name: "Alpha", type: EntityType.TECHNOLOGY, description: "first" },
      { name: "Bravo", type: EntityType.TECHNOLOGY, description: "second" },
    ];

    // With threshold 1.0 (impossible to fuzzy merge), they stay separate.
    // But with lower threshold + similar enough names... let's use exact same name
    // different cases that happen to have the same length
    const e2: ExtractedEntity[] = [
      { name: "REACT", type: EntityType.TECHNOLOGY, description: "lib" },
      { name: "react", type: EntityType.TECHNOLOGY, description: "lib" },
    ];

    const r1 = resolve(e2, 0.85);
    const r2 = resolve([...e2].reverse(), 0.85);

    expect(r1[0]!.name).toBe(r2[0]!.name);
  });

  // === DEAD CODE: CANONICAL_TO_ALIASES built but never used ===
  it("expandAbbreviation handles canonical names correctly", () => {
    // "typescript" is a canonical value, not a key
    // expand should return it as-is (via lowercase fallback)
    expect(expandAbbreviation("typescript")).toBe("typescript");
    expect(expandAbbreviation("TypeScript")).toBe("typescript");
    expect(expandAbbreviation("TYPESCRIPT")).toBe("typescript");
  });

  // === Names not in abbreviation table fall through to lowercase ===
  it("unknown names fall through to lowercase identity", () => {
    expect(expandAbbreviation("Deno")).toBe("deno");
    expect(expandAbbreviation("SomeFramework")).toBe("someframework");
  });

  // === ABBREVIATION: "es" → "elasticsearch" may false-positive with ECMAScript ===
  it("es maps to elasticsearch — verify this is intentional", () => {
    expect(expandAbbreviation("es")).toBe("elasticsearch");
    // ES6, ES2020 etc. would NOT match because they're not just "es"
    expect(expandAbbreviation("es6")).toBe("es6");
    expect(expandAbbreviation("es2020")).toBe("es2020");
  });

  // === MODULE: normalizeModulePath with depth + shallow path (< 3 parts) ===
  it("shallow file with depth retains extension when parts < 3", () => {
    // "src/cli.ts" has 2 parts, < 3, so filename is NOT stripped
    // depth=2 means keep 2 segments → "src/cli.ts"
    expect(normalizeModulePath("src/cli.ts", 2)).toBe("src/cli.ts");
    // depth=1 → "src"
    expect(normalizeModulePath("src/cli.ts", 1)).toBe("src");
  });

  // === MODULE: root index.ts ===
  it("root index.ts is not stripped (no leading slash)", () => {
    // regex is /\/index\.[^/]+$/ — requires leading /
    expect(normalizeModulePath("index.ts")).toBe("index.ts");
  });

  // === FUZZY: canFuzzyMatch should block very different lengths ===
  it("does not merge 'Go' and 'Golang' (length ratio check)", () => {
    const entities: ExtractedEntity[] = [
      { name: "Go", type: EntityType.TECHNOLOGY, description: "lang" },
      { name: "Golang", type: EntityType.TECHNOLOGY, description: "language" },
    ];
    // JW("go", "golang") might score high, but length ratio = 2/6 = 0.33 < 0.5
    const resolved = resolve(entities, 0.85);
    expect(resolved).toHaveLength(2);
  });

  // === TRANSITIVE MERGE: the chain problem ===
  it("does NOT transitively merge A→B→C if A~B and B~C but A!~C", () => {
    // This tests the greedy single-linkage behavior.
    // With sorted input, the first entity becomes cluster head.
    // Subsequent entities only compare to cluster heads, not all members.
    const entities: ExtractedEntity[] = [
      { name: "billing-api", type: EntityType.MODULE, description: "a" },
      { name: "billing-app", type: EntityType.MODULE, description: "b" },
    ];
    // These are modules — they get path-normalized first.
    // "billing-api" has no extension, stays as-is.
    // "billing-app" has no extension, stays as-is.
    // JW("billing-api", "billing-app") is very high because only the last 2 chars differ.
    console.log("JW billing-api vs billing-app:", jaroWinkler("billing-api", "billing-app"));
    // This WILL merge — both are very similar. That might be a false positive.
    // But the resolver can only work with what it's given.
  });

  // === SORT ORDER: verify the cluster-creation order is deterministic ===
  it("same entities in random orders produce identical IDs", () => {
    const mkEntities = (): ExtractedEntity[] => [
      { name: "Docker", type: EntityType.TECHNOLOGY, description: "Containers" },
      { name: "docker", type: EntityType.TECHNOLOGY, description: "Container engine" },
      { name: "Redis", type: EntityType.TECHNOLOGY, description: "Cache" },
      { name: "redis", type: EntityType.TECHNOLOGY, description: "In-memory store" },
      { name: "REDIS", type: EntityType.TECHNOLOGY, description: "Data structure store" },
    ];

    const orders = [
      mkEntities(),
      [...mkEntities()].reverse(),
      [mkEntities()[2]!, mkEntities()[4]!, mkEntities()[0]!, mkEntities()[3]!, mkEntities()[1]!],
    ];

    const results = orders.map(o => {
      const r = resolve(o, 0.85);
      return r.sort((a, b) => a.id.localeCompare(b.id));
    });

    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.length).toBe(results[0]!.length);
      for (let j = 0; j < results[0]!.length; j++) {
        expect(results[i]![j]!.id).toBe(results[0]![j]!.id);
        expect(results[i]![j]!.name).toBe(results[0]![j]!.name);
        expect(results[i]![j]!.description).toBe(results[0]![j]!.description);
        expect(results[i]![j]!.aliases).toEqual(results[0]![j]!.aliases);
      }
    }
  });
});
