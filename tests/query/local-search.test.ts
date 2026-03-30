import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { Store } from "../../src/store/queries.js";
import { createPopulatedStore } from "../helpers/sample-store.js";
import { localSearch } from "../../src/query/local-search.js";
import { EntityType } from "../../src/shared/types.js";

describe("localSearch", () => {
  let db: Database.Database;
  let store: Store;

  beforeEach(() => {
    ({ db, store } = createPopulatedStore());
  });
  afterEach(() => db.close());

  it("finds entities matching a query", () => {
    const result = localSearch(store, { query: "payments" });

    expect(result.entities.length).toBeGreaterThan(0);
    const names = result.entities.map((e) => e.name);
    expect(names).toContain("src/payments");
  });

  it("includes relations for matched entities", () => {
    const result = localSearch(store, { query: "payments" });

    expect(result.relations.length).toBeGreaterThan(0);
  });

  it("includes text units as supporting evidence", () => {
    const result = localSearch(store, { query: "payments gRPC" });

    expect(result.textUnits.length).toBeGreaterThan(0);
    // Text unit about gRPC migration should be included
    const hasGrpcContent = result.textUnits.some((tu) =>
      tu.content.toLowerCase().includes("grpc"),
    );
    expect(hasGrpcContent).toBe(true);
  });

  it("includes community context", () => {
    const result = localSearch(store, { query: "payments" });

    expect(result.communities.length).toBeGreaterThan(0);
    const titles = result.communities.map((c) => c.title);
    expect(
      titles.some((t) => t.toLowerCase().includes("payment")),
    ).toBe(true);
  });

  it("expands 1-hop via relations", () => {
    // Search for "Alice" → should also find modules she authored
    const result = localSearch(store, { query: "Alice" });

    const names = result.entities.map((e) => e.name);
    expect(names).toContain("Alice Chen");
    // 1-hop expansion should include modules Alice is connected to
    expect(
      names.some((n) => n.includes("payments") || n.includes("middleware")),
    ).toBe(true);
  });

  it("filters by entity type", () => {
    const result = localSearch(store, {
      query: "payments",
      entityTypes: [EntityType.MODULE],
    });

    // Seed entities should only be MODULE type
    expect(result.entities.length).toBeGreaterThan(0);
    const moduleEntities = result.entities.filter(
      (e) => e.type === EntityType.MODULE,
    );
    expect(moduleEntities.length).toBeGreaterThan(0);
    expect(moduleEntities[0]!.name).toBe("src/payments");
  });

  it("respects maxEntities limit", () => {
    const result = localSearch(store, {
      query: "payments billing",
      maxEntities: 2,
    });

    expect(result.entities.length).toBeLessThanOrEqual(2);
  });

  it("returns empty for no matches", () => {
    const result = localSearch(store, { query: "zzz-nonexistent-xyz" });

    expect(result.entities).toHaveLength(0);
    expect(result.relations).toHaveLength(0);
    expect(result.textUnits).toHaveLength(0);
    expect(result.communities).toHaveLength(0);
  });
});
