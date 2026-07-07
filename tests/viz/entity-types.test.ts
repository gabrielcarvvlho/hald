import { describe, expect, it } from "vitest";
// @ts-expect-error - browser ESM module, no .d.ts; runtime-importable in Node.
import {
  entityTypeLabel,
  entityTypeMark,
  normalizeEntityType,
} from "../../src/viz/public/entity-types.js";
// @ts-expect-error - browser ESM module, no .d.ts; runtime-importable in Node.
import { filterStateLabel } from "../../src/viz/public/search-filters.js";

describe("entity type visual language", () => {
  it("normalizes entity types for display", () => {
    expect(normalizeEntityType(" module ")).toBe("MODULE");
    expect(entityTypeLabel("TECHNOLOGY")).toBe("Technology");
    expect(entityTypeLabel("API_GATEWAY")).toBe("Api Gateway");
  });

  it("uses stable neutral marks for known types", () => {
    expect(entityTypeMark("PERSON")).toBe("PE");
    expect(entityTypeMark("MODULE")).toBe("MO");
    expect(entityTypeMark("DECISION")).toBe("DE");
    expect(entityTypeMark("PATTERN")).toBe("PA");
  });

  it("derives fallback marks without relying on color", () => {
    expect(entityTypeMark("CUSTOM_THING")).toBe("CU");
    expect(entityTypeMark("x")).toBe("X-");
    expect(entityTypeMark("")).toBe("--");
  });
});

describe("filterStateLabel", () => {
  it("makes all-on, partial, none, and empty states explicit", () => {
    expect(filterStateLabel(5, 5)).toBe("All 5 types visible");
    expect(filterStateLabel(3, 5)).toBe("3 of 5 types visible");
    expect(filterStateLabel(0, 5)).toBe("No types visible");
    expect(filterStateLabel(0, 0)).toBe("No entity types");
  });
});
