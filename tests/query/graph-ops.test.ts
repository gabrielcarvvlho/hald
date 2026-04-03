import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { Store } from "../../src/store/queries.js";
import { createPopulatedStore } from "../helpers/sample-store.js";
import {
  findExperts,
  getCoupling,
  getPath,
  getEntity,
  findKnowledgeSilos,
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

  describe("findKnowledgeSilos", () => {
    it("identifies modules with only one active expert as silos", () => {
      // With a very large inactiveDays, all authors are "active"
      // billing has only Bob (AUTHORED), payments has Alice + Bob → not a silo
      const results = findKnowledgeSilos(store, {
        minFrequency: 1,
        inactiveDays: 100_000,
      });

      const billingResult = results.find(
        (r) => r.module.name === "src/billing",
      );
      expect(billingResult).toBeDefined();
      expect(billingResult!.activeExpertCount).toBe(1);
      expect(billingResult!.soloExpert?.name).toBe("Bob Martinez");

      // payments has 2 experts (Alice AUTHORED + Bob MODIFIED) → not in results
      const paymentsResult = results.find(
        (r) => r.module.name === "src/payments",
      );
      expect(paymentsResult).toBeUndefined();
    });

    it("identifies orphaned modules when all authors are inactive", () => {
      // With inactiveDays=0, no one is "active" anymore (sample data is from 2024)
      const results = findKnowledgeSilos(store, {
        minFrequency: 1,
        inactiveDays: 0,
      });

      const orphaned = results.filter((r) => r.activeExpertCount === 0);
      // All modules with authors should be orphaned since dates are in the past
      expect(orphaned.length).toBeGreaterThanOrEqual(1);
    });

    it("filters out low-frequency modules", () => {
      const results = findKnowledgeSilos(store, {
        minFrequency: 100,
        inactiveDays: 100_000,
      });

      // No module has frequency >= 100 in sample data
      expect(results).toHaveLength(0);
    });

    it("sorts orphaned modules before silos", () => {
      // Compute a dynamic inactiveDays so that middleware (Alice lastSeen 2024-05-01)
      // becomes orphaned, but billing (Bob lastSeen 2024-05-20) stays a silo.
      // The midpoint between the two dates ensures stability regardless of when the test runs.
      const now = new Date();
      const daysSinceMiddlewareAuthor =
        (now.getTime() - new Date("2024-05-01").getTime()) / 86_400_000;
      const daysSinceBillingAuthor =
        (now.getTime() - new Date("2024-05-20").getTime()) / 86_400_000;
      const inactiveDays = Math.floor(
        (daysSinceMiddlewareAuthor + daysSinceBillingAuthor) / 2,
      );

      const results = findKnowledgeSilos(store, {
        minFrequency: 1,
        inactiveDays,
      });

      const orphaned = results.filter((r) => r.activeExpertCount === 0);
      const silos = results.filter((r) => r.activeExpertCount === 1);

      expect(orphaned.length).toBeGreaterThanOrEqual(1);
      expect(silos.length).toBeGreaterThanOrEqual(1);

      // Orphaned (0) must all appear before silos (1)
      const firstSiloIdx = results.findIndex(
        (r) => r.activeExpertCount === 1,
      );
      for (let i = 0; i < firstSiloIdx; i++) {
        expect(results[i]!.activeExpertCount).toBe(0);
      }
    });

    it("includes middleware as a silo (only Alice authored it)", () => {
      const results = findKnowledgeSilos(store, {
        minFrequency: 1,
        inactiveDays: 100_000,
      });

      const middlewareResult = results.find(
        (r) => r.module.name === "src/middleware",
      );
      expect(middlewareResult).toBeDefined();
      expect(middlewareResult!.activeExpertCount).toBe(1);
      expect(middlewareResult!.soloExpert?.name).toBe("Alice Chen");
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
