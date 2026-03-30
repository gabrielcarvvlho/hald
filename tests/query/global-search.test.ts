import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { Store } from "../../src/store/queries.js";
import { createPopulatedStore } from "../helpers/sample-store.js";
import { globalSearch, classifyQuery } from "../../src/query/global-search.js";

describe("globalSearch", () => {
  let db: Database.Database;
  let store: Store;

  beforeEach(() => {
    ({ db, store } = createPopulatedStore());
  });
  afterEach(() => db.close());

  it("finds communities matching a query", () => {
    const result = globalSearch(store, { query: "payments gRPC migration" });

    expect(result.communities.length).toBeGreaterThan(0);
    const titles = result.communities.map((c) => c.title);
    expect(
      titles.some((t) => t.toLowerCase().includes("payment")),
    ).toBe(true);
  });

  it("returns communities with summaries", () => {
    const result = globalSearch(store, { query: "billing" });

    for (const community of result.communities) {
      expect(community.summary.length).toBeGreaterThan(0);
      expect(community.title.length).toBeGreaterThan(0);
    }
  });

  it("respects maxCommunities limit", () => {
    const result = globalSearch(store, {
      query: "payments billing",
      maxCommunities: 1,
    });

    expect(result.communities.length).toBeLessThanOrEqual(1);
  });

  it("returns empty for no matches", () => {
    const result = globalSearch(store, { query: "zzz-nonexistent-xyz" });
    expect(result.communities).toHaveLength(0);
  });

  it("filters by community level", () => {
    const result = globalSearch(store, {
      query: "payments",
      communityLevel: 0,
    });

    for (const c of result.communities) {
      expect(c.level).toBe(0);
    }
  });
});

describe("classifyQuery", () => {
  it("classifies 'who knows' as local", () => {
    expect(classifyQuery("who knows the billing module?")).toBe("local");
    expect(classifyQuery("who maintains src/payments?")).toBe("local");
    expect(classifyQuery("who wrote the auth middleware?")).toBe("local");
  });

  it("classifies expert/owner queries as local", () => {
    expect(classifyQuery("find the expert for billing")).toBe("local");
    expect(classifyQuery("find the owner of payments")).toBe("local");
  });

  it("classifies coupling queries as local", () => {
    expect(classifyQuery("show coupling for billing")).toBe("local");
    expect(classifyQuery("show dependencies of payments")).toBe("local");
  });

  it("classifies 'why did we' as global", () => {
    expect(classifyQuery("why did we migrate to gRPC?")).toBe("global");
    expect(classifyQuery("why did the team switch frameworks?")).toBe(
      "global",
    );
  });

  it("classifies history/overview as global", () => {
    expect(classifyQuery("history of the payments module")).toBe("global");
    expect(classifyQuery("overview of the architecture")).toBe("global");
    expect(
      classifyQuery("tell me about the architecture of this system"),
    ).toBe("global");
    expect(classifyQuery("what are the main components?")).toBe("global");
  });

  it("classifies decision questions as global", () => {
    expect(
      classifyQuery("what was the reason for the migration?"),
    ).toBe("global");
    expect(
      classifyQuery("how did the payments service evolve?"),
    ).toBe("global");
  });

  it("defaults to local for ambiguous queries", () => {
    expect(classifyQuery("billing module")).toBe("local");
    expect(classifyQuery("gRPC")).toBe("local");
  });
});
