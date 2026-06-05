import { describe, it, expect } from "vitest";
// @ts-expect-error — browser ESM module, no .d.ts; runtime-importable in Node.
import { hasEntityDetail, notFoundSidebarHtml } from "../../src/viz/public/sidebar.js";

// These pure helpers back the node-detail 404 handling in selectNode().
// A 404 from /api/entity/:id must NOT be handled by an accidental TypeError
// thrown deep inside renderSidebar() (reading detail.entity.name on undefined).
// Instead selectNode() checks response.ok and renderSidebar() guards on a
// present detail.entity, short-circuiting to a clean "entity not found" panel.

describe("hasEntityDetail", () => {
  it("returns true for a well-formed detail with an entity", () => {
    expect(hasEntityDetail({ entity: { name: "billing" } })).toBe(true);
  });

  it("returns false for a 404-shaped body with no entity", () => {
    // Servers commonly return { error: "not found" } on a 404.
    expect(hasEntityDetail({ error: "not found" })).toBe(false);
  });

  it("returns false for a missing/empty entity", () => {
    expect(hasEntityDetail({})).toBe(false);
    expect(hasEntityDetail({ entity: null })).toBe(false);
    expect(hasEntityDetail({ entity: undefined })).toBe(false);
  });

  it("returns false for a nullish detail", () => {
    expect(hasEntityDetail(null)).toBe(false);
    expect(hasEntityDetail(undefined)).toBe(false);
  });
});

describe("notFoundSidebarHtml", () => {
  it("renders a clean, human-readable not-found message", () => {
    const html = notFoundSidebarHtml();
    expect(html).toContain("not found");
    // Must be a non-empty string we can drop into the sidebar.
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);
  });
});
