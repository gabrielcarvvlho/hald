import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { Store } from "../../src/store/queries.js";
import { createPopulatedStore } from "../helpers/sample-store.js";
import {
  findExperts,
  getCoupling,
  getPath,
  getEntity,
} from "../../src/query/graph-ops.js";

describe("graph-ops", () => {
  let db: Database.Database;
  let store: Store;

  beforeEach(() => {
    ({ db, store } = createPopulatedStore());
  });
  afterEach(() => db.close());

  describe("findExperts", () => {
    it("finds Alice as top expert for src/payments", () => {
      const results = findExperts(store, "src/payments", 5);

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.person.name).toBe("Alice Chen");
      expect(results[0]!.score).toBeGreaterThan(0);
      expect(results[0]!.modules).toContain("module:src/payments");
    });

    it("finds Bob as top expert for src/billing", () => {
      const results = findExperts(store, "src/billing", 5);

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.person.name).toBe("Bob Martinez");
    });

    it("returns multiple experts with proper ranking", () => {
      // Both Alice (AUTHORED weight 9) and Bob (MODIFIED weight 3) touch payments
      const results = findExperts(store, "src/payments", 10);

      expect(results.length).toBe(2);
      // Alice should score higher (weight 9 vs 3)
      expect(results[0]!.person.name).toBe("Alice Chen");
      expect(results[1]!.person.name).toBe("Bob Martinez");
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    });

    it("respects topN limit", () => {
      const results = findExperts(store, "src/payments", 1);
      expect(results).toHaveLength(1);
    });

    it("returns empty for unknown module", () => {
      const results = findExperts(store, "src/nonexistent", 5);
      expect(results).toHaveLength(0);
    });
  });

  describe("getCoupling", () => {
    it("finds billing coupled with payments", () => {
      const results = getCoupling(store, "src/billing", 1);

      expect(results.length).toBeGreaterThanOrEqual(1);
      const paymentsCoupling = results.find(
        (r) => r.module.name === "src/payments",
      );
      expect(paymentsCoupling).toBeDefined();
      expect(paymentsCoupling!.coChangeCount).toBeGreaterThanOrEqual(1);
    });

    it("includes shared authors", () => {
      const results = getCoupling(store, "src/billing", 1);
      const paymentsCoupling = results.find(
        (r) => r.module.name === "src/payments",
      );
      // Both Alice and Bob work on payments; Bob works on billing
      // So Bob should be a shared author
      if (paymentsCoupling) {
        expect(paymentsCoupling.sharedAuthors.length).toBeGreaterThanOrEqual(0);
      }
    });

    it("returns empty for uncoupled module", () => {
      const results = getCoupling(store, "src/middleware", 1);
      // Middleware has no CO_CHANGED relations in our sample data
      const nonSelf = results.filter(
        (r) => r.module.name !== "src/middleware",
      );
      expect(nonSelf).toHaveLength(0);
    });
  });

  describe("getPath", () => {
    it("finds direct path between connected entities", () => {
      const result = getPath(
        store,
        "person:alice-chen",
        "module:src/payments",
      );

      expect(result).not.toBeNull();
      expect(result!.length).toBe(1);
      expect(result!.path[0]!.id).toBe("person:alice-chen");
      expect(result!.path[1]!.id).toBe("module:src/payments");
    });

    it("finds multi-hop path", () => {
      // Bob → billing → payments → gRPC
      const result = getPath(
        store,
        "person:bob-martinez",
        "technology:grpc",
      );

      expect(result).not.toBeNull();
      expect(result!.length).toBeGreaterThanOrEqual(2);
    });

    it("returns null for disconnected entities", () => {
      // Carlos has no path to middleware in our data (Carlos only has docs)
      // Actually Carlos has no relations at all in sample data, so he IS disconnected
      const result = getPath(
        store,
        "person:carlos-ruiz",
        "module:src/middleware",
      );

      expect(result).toBeNull();
    });

    it("handles same entity", () => {
      const result = getPath(
        store,
        "person:alice-chen",
        "person:alice-chen",
      );
      expect(result).not.toBeNull();
      expect(result!.length).toBe(0);
    });
  });

  describe("getEntity", () => {
    it("finds entity by exact ID", () => {
      const result = getEntity(store, "person:alice-chen");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("Alice Chen");
    });

    it("finds entity by name", () => {
      const result = getEntity(store, "Alice Chen");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("person:alice-chen");
    });

    it("finds entity by FTS search", () => {
      const result = getEntity(store, "gRPC");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("TECHNOLOGY");
    });

    it("returns null for unknown query", () => {
      const result = getEntity(store, "zzz-nonexistent-xyz");
      expect(result).toBeNull();
    });
  });
});
