import { describe, it, expect } from "vitest";
import {
  resolve,
  jaroWinkler,
  normalizeModulePath,
  generateEntityId,
  isAliasMatch,
  expandAbbreviation,
} from "../../src/pipeline/resolver.js";
import { EntityType } from "../../src/shared/types.js";
import type { ExtractedEntity } from "../../src/pipeline/extractor.js";

describe("jaroWinkler", () => {
  it("returns 1 for identical strings", () => {
    expect(jaroWinkler("hello", "hello")).toBe(1);
  });

  it("returns 0 for completely different strings", () => {
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });

  it("returns high similarity for similar strings", () => {
    expect(jaroWinkler("alice", "alce")).toBeGreaterThan(0.9);
    expect(jaroWinkler("React", "ReactJS")).toBeGreaterThan(0.85);
  });

  it("returns low similarity for different strings", () => {
    expect(jaroWinkler("python", "javascript")).toBeLessThan(0.6);
  });

  it("handles empty strings", () => {
    expect(jaroWinkler("", "hello")).toBe(0);
    expect(jaroWinkler("hello", "")).toBe(0);
    expect(jaroWinkler("", "")).toBe(1);
  });
});

describe("normalizeModulePath", () => {
  it("strips index files", () => {
    expect(normalizeModulePath("src/billing/index.ts")).toBe("src/billing");
    expect(normalizeModulePath("src/billing/index.js")).toBe("src/billing");
  });

  it("groups deeper files to directory", () => {
    expect(normalizeModulePath("src/billing/processor.ts")).toBe("src/billing");
    expect(normalizeModulePath("src/payments/handler.ts")).toBe("src/payments");
  });

  it("keeps shallow paths as-is", () => {
    expect(normalizeModulePath("src/cli.ts")).toBe("src/cli.ts");
    expect(normalizeModulePath("package.json")).toBe("package.json");
  });

  it("keeps paths without extensions", () => {
    expect(normalizeModulePath("src/billing")).toBe("src/billing");
  });

  describe("configurable depth", () => {
    it("truncates to depth=2", () => {
      expect(normalizeModulePath("src/api/routes/auth.ts", 2)).toBe("src/api");
      expect(normalizeModulePath("src/api/middleware/auth.ts", 2)).toBe("src/api");
    });

    it("truncates to depth=3", () => {
      expect(normalizeModulePath("src/api/routes/auth.ts", 3)).toBe("src/api/routes");
      expect(normalizeModulePath("lib/a/b/c/deep.ts", 3)).toBe("lib/a/b");
    });

    it("does not truncate if path has fewer segments than depth", () => {
      expect(normalizeModulePath("src/billing", 5)).toBe("src/billing");
    });

    it("handles depth=1 for monorepo top-level grouping", () => {
      expect(normalizeModulePath("packages/billing/src/handler.ts", 1)).toBe("packages");
    });

    it("without depth, uses default directory stripping", () => {
      expect(normalizeModulePath("src/api/routes/auth.ts")).toBe("src/api/routes");
      expect(normalizeModulePath("src/billing/processor.ts")).toBe("src/billing");
    });
  });
});

describe("generateEntityId", () => {
  it("creates id from type and name", () => {
    expect(generateEntityId(EntityType.PERSON, "Alice Chen")).toBe("person:alice-chen");
    expect(generateEntityId(EntityType.MODULE, "src/billing")).toBe("module:src/billing");
  });

  it("normalizes special characters", () => {
    expect(generateEntityId(EntityType.TECHNOLOGY, "gRPC")).toBe("technology:grpc");
  });
});

describe("abbreviation matching", () => {
  it("expands known abbreviations", () => {
    expect(expandAbbreviation("ts")).toBe("typescript");
    expect(expandAbbreviation("TS")).toBe("typescript");
    expect(expandAbbreviation("k8s")).toBe("kubernetes");
    expect(expandAbbreviation("pg")).toBe("postgresql");
    expect(expandAbbreviation("postgres")).toBe("postgresql");
  });

  it("returns original for unknown names", () => {
    expect(expandAbbreviation("React")).toBe("react");
    expect(expandAbbreviation("unknown-thing")).toBe("unknown-thing");
  });

  it("detects alias matches", () => {
    expect(isAliasMatch("TypeScript", "TS")).toBe(true);
    expect(isAliasMatch("kubernetes", "k8s")).toBe(true);
    expect(isAliasMatch("PostgreSQL", "pg")).toBe(true);
    expect(isAliasMatch("PostgreSQL", "postgres")).toBe(true);
    expect(isAliasMatch("vue.js", "Vue")).toBe(true);
    expect(isAliasMatch("reactjs", "React.js")).toBe(true);
  });

  it("does not alias-match unrelated names", () => {
    expect(isAliasMatch("TypeScript", "Python")).toBe(false);
    expect(isAliasMatch("React", "Vue")).toBe(false);
  });
});

describe("resolve", () => {
  it("merges exact duplicates", () => {
    const entities: ExtractedEntity[] = [
      { name: "Alice Chen", type: EntityType.PERSON, description: "Developer" },
      { name: "Alice Chen", type: EntityType.PERSON, description: "Lead developer of payments" },
    ];

    const resolved = resolve(entities, 0.85);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("Alice Chen");
    // Should pick the longer description
    expect(resolved[0]!.description).toContain("Lead developer");
  });

  it("merges fuzzy matches above threshold", () => {
    const entities: ExtractedEntity[] = [
      { name: "Alice Chen", type: EntityType.PERSON, description: "Dev" },
      { name: "Alice  Chen", type: EntityType.PERSON, description: "Dev too" },
    ];

    const resolved = resolve(entities, 0.85);
    expect(resolved).toHaveLength(1);
  });

  it("keeps distinct entities separate", () => {
    const entities: ExtractedEntity[] = [
      { name: "Alice Chen", type: EntityType.PERSON, description: "Dev" },
      { name: "Bob Martinez", type: EntityType.PERSON, description: "Dev" },
    ];

    const resolved = resolve(entities, 0.85);
    expect(resolved).toHaveLength(2);
  });

  it("does not merge across types", () => {
    const entities: ExtractedEntity[] = [
      { name: "React", type: EntityType.TECHNOLOGY, description: "UI framework" },
      { name: "React", type: EntityType.MODULE, description: "React module" },
    ];

    const resolved = resolve(entities, 0.85);
    expect(resolved).toHaveLength(2);
  });

  it("normalizes module paths before resolving", () => {
    const entities: ExtractedEntity[] = [
      {
        name: "src/billing/processor.ts",
        type: EntityType.MODULE,
        description: "Billing processor",
      },
      { name: "src/billing/types.ts", type: EntityType.MODULE, description: "Billing types" },
    ];

    // Both normalize to "src/billing"
    const resolved = resolve(entities, 0.85);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("src/billing");
  });

  it("collects aliases from merged entities", () => {
    const entities: ExtractedEntity[] = [
      { name: "Alice Chen", type: EntityType.PERSON, description: "a" },
      { name: "Alice Chen", type: EntityType.PERSON, description: "b" },
      { name: "alice chen", type: EntityType.PERSON, description: "c" },
    ];

    const resolved = resolve(entities, 0.85);
    expect(resolved).toHaveLength(1);
    // "Alice Chen" is canonical (most frequent), "alice chen" is alias
    expect(resolved[0]!.aliases).toContain("alice chen");
  });

  it("generates valid entity IDs", () => {
    const entities: ExtractedEntity[] = [
      { name: "Alice", type: EntityType.PERSON, description: "dev" },
    ];

    const resolved = resolve(entities, 0.85);
    expect(resolved[0]!.id).toBe("person:alice");
    expect(resolved[0]!.type).toBe(EntityType.PERSON);
  });

  it("handles empty input", () => {
    expect(resolve([], 0.85)).toHaveLength(0);
  });

  // === NEW: Abbreviation-based merging ===

  it("merges TypeScript and TS via abbreviation table", () => {
    const entities: ExtractedEntity[] = [
      { name: "TypeScript", type: EntityType.TECHNOLOGY, description: "Programming language" },
      { name: "TS", type: EntityType.TECHNOLOGY, description: "TypeScript shorthand" },
    ];

    const resolved = resolve(entities, 0.85);
    expect(resolved).toHaveLength(1);
    // Canonical should be the longer/more frequent name
    expect(resolved[0]!.name).toBe("TypeScript");
    expect(resolved[0]!.aliases).toContain("TS");
  });

  it("merges kubernetes and k8s via abbreviation table", () => {
    const entities: ExtractedEntity[] = [
      { name: "Kubernetes", type: EntityType.TECHNOLOGY, description: "Container orchestration" },
      { name: "k8s", type: EntityType.TECHNOLOGY, description: "K8s platform" },
    ];

    const resolved = resolve(entities, 0.85);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("Kubernetes");
  });

  it("merges PostgreSQL, postgres, and pg", () => {
    const entities: ExtractedEntity[] = [
      { name: "PostgreSQL", type: EntityType.TECHNOLOGY, description: "Relational database" },
      { name: "postgres", type: EntityType.TECHNOLOGY, description: "Postgres DB" },
      { name: "pg", type: EntityType.TECHNOLOGY, description: "PG driver" },
    ];

    const resolved = resolve(entities, 0.85);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("PostgreSQL");
    expect(resolved[0]!.aliases).toContain("postgres");
    expect(resolved[0]!.aliases).toContain("pg");
  });

  // === NEW: Determinism ===

  it("produces deterministic output regardless of input order", () => {
    const base: ExtractedEntity[] = [
      { name: "Alice Chen", type: EntityType.PERSON, description: "Developer" },
      { name: "alice chen", type: EntityType.PERSON, description: "dev at ACME" },
      { name: "Bob Smith", type: EntityType.PERSON, description: "Engineer" },
      { name: "TypeScript", type: EntityType.TECHNOLOGY, description: "Language" },
      { name: "TS", type: EntityType.TECHNOLOGY, description: "TS lang" },
    ];

    // Run with original order
    const result1 = resolve(base, 0.85);

    // Run with reversed order
    const result2 = resolve([...base].reverse(), 0.85);

    // Run with shuffled order
    const shuffled = [base[3]!, base[0]!, base[4]!, base[2]!, base[1]!];
    const result3 = resolve(shuffled, 0.85);

    // All should produce identical results
    expect(result1.length).toBe(result2.length);
    expect(result1.length).toBe(result3.length);

    // Sort by id for comparison
    const sort = (r: typeof result1) => r.sort((a, b) => a.id.localeCompare(b.id));
    const s1 = sort(result1);
    const s2 = sort(result2);
    const s3 = sort(result3);

    for (let i = 0; i < s1.length; i++) {
      expect(s1[i]!.id).toBe(s2[i]!.id);
      expect(s1[i]!.id).toBe(s3[i]!.id);
      expect(s1[i]!.name).toBe(s2[i]!.name);
      expect(s1[i]!.name).toBe(s3[i]!.name);
      expect(s1[i]!.aliases).toEqual(s2[i]!.aliases);
      expect(s1[i]!.aliases).toEqual(s3[i]!.aliases);
    }
  });

  // === NEW: Configurable module depth ===

  it("respects moduleDepth option for module normalization", () => {
    const entities: ExtractedEntity[] = [
      { name: "src/api/routes/auth.ts", type: EntityType.MODULE, description: "Auth routes" },
      { name: "src/api/routes/billing.ts", type: EntityType.MODULE, description: "Billing routes" },
      {
        name: "src/api/middleware/cors.ts",
        type: EntityType.MODULE,
        description: "CORS middleware",
      },
    ];

    // With depth=2: all collapse to "src/api"
    const depth2 = resolve(entities, { threshold: 0.85, moduleDepth: 2 });
    expect(depth2).toHaveLength(1);
    expect(depth2[0]!.name).toBe("src/api");

    // With depth=3: routes and middleware stay separate
    const depth3 = resolve(entities, { threshold: 0.85, moduleDepth: 3 });
    expect(depth3).toHaveLength(2);
    const names = depth3.map((e) => e.name).sort();
    expect(names).toEqual(["src/api/middleware", "src/api/routes"]);
  });

  // === NEW: False positive prevention ===

  it("does not merge short dissimilar tech names", () => {
    const entities: ExtractedEntity[] = [
      { name: "SQL", type: EntityType.TECHNOLOGY, description: "Query language" },
      { name: "SSL", type: EntityType.TECHNOLOGY, description: "Encryption" },
    ];

    const resolved = resolve(entities, 0.85);
    expect(resolved).toHaveLength(2);
  });

  it("does not merge names with very different lengths", () => {
    const entities: ExtractedEntity[] = [
      { name: "Go", type: EntityType.TECHNOLOGY, description: "Programming language" },
      { name: "Google Cloud Platform", type: EntityType.TECHNOLOGY, description: "Cloud" },
    ];

    const resolved = resolve(entities, 0.85);
    expect(resolved).toHaveLength(2);
  });

  // === NEW: Alias determinism ===

  it("produces sorted aliases for deterministic output", () => {
    const entities: ExtractedEntity[] = [
      { name: "PostgreSQL", type: EntityType.TECHNOLOGY, description: "DB" },
      { name: "pg", type: EntityType.TECHNOLOGY, description: "Driver" },
      { name: "postgres", type: EntityType.TECHNOLOGY, description: "Server" },
      { name: "Postgres", type: EntityType.TECHNOLOGY, description: "Also server" },
    ];

    const resolved = resolve(entities, 0.85);
    expect(resolved).toHaveLength(1);
    // Aliases should be sorted
    const aliases = resolved[0]!.aliases;
    const sortedAliases = [...aliases].sort();
    expect(aliases).toEqual(sortedAliases);
  });
});
