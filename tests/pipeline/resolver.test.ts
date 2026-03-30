import { describe, it, expect } from "vitest";
import {
  resolve,
  jaroWinkler,
  normalizeModulePath,
  generateEntityId,
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
});

describe("generateEntityId", () => {
  it("creates id from type and name", () => {
    expect(generateEntityId(EntityType.PERSON, "Alice Chen")).toBe(
      "person:alice-chen",
    );
    expect(generateEntityId(EntityType.MODULE, "src/billing")).toBe(
      "module:src/billing",
    );
  });

  it("normalizes special characters", () => {
    expect(generateEntityId(EntityType.TECHNOLOGY, "gRPC")).toBe(
      "technology:grpc",
    );
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
      { name: "src/billing/processor.ts", type: EntityType.MODULE, description: "Billing processor" },
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
});
