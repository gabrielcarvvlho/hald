import { describe, it, expect } from "vitest";
// @ts-expect-error — browser ESM module, no .d.ts; runtime-importable in Node.
import {
  buildOverviewModel,
  hasCommunityDetail,
  hasEntityDetail,
  nextInspectorSelection,
  notFoundSidebarHtml,
} from "../../src/viz/public/sidebar.js";

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

describe("hasCommunityDetail", () => {
  it("returns true for a community detail shape", () => {
    expect(hasCommunityDetail({ id: "comm:1", title: "Auth" })).toBe(true);
  });

  it("returns false for missing community identity", () => {
    expect(hasCommunityDetail({ error: "not found" })).toBe(false);
    expect(hasCommunityDetail({ id: "" })).toBe(false);
    expect(hasCommunityDetail(null)).toBe(false);
  });
});

describe("nextInspectorSelection", () => {
  it("selects nodes and clears community selection", () => {
    expect(
      nextInspectorSelection(
        { selectedNode: null, selectedCommunity: "comm:1" },
        { type: "node", id: "module:auth" },
      ),
    ).toEqual({ selectedNode: "module:auth", selectedCommunity: null });
  });

  it("selects communities and clears node selection", () => {
    expect(
      nextInspectorSelection(
        { selectedNode: "module:auth", selectedCommunity: null },
        { type: "community", id: "comm:1" },
      ),
    ).toEqual({ selectedNode: null, selectedCommunity: "comm:1" });
  });

  it("returns overview selection for clear actions", () => {
    expect(
      nextInspectorSelection(
        { selectedNode: "module:auth", selectedCommunity: null },
        { type: "overview" },
      ),
    ).toEqual({ selectedNode: null, selectedCommunity: null });
  });
});

describe("buildOverviewModel", () => {
  it("summarizes stats, top communities, and entity type mix", () => {
    const model = buildOverviewModel(
      {
        nodes: [
          { id: "a", type: "MODULE", communityId: "comm:1" },
          { id: "b", type: "PERSON", communityId: "comm:1" },
          { id: "c", type: "MODULE", communityId: "comm:2" },
        ],
        edges: [{ id: "r1" }],
        communities: [
          { id: "comm:2", title: "Storage", summary: "", color: "#10b981" },
          { id: "comm:1", title: "Auth", summary: "", color: "#3b82f6" },
        ],
        truncated: null,
      },
      {
        entities: 3,
        relations: 1,
        communities: 2,
        commits: 9,
        lastIndexedAt: null,
      },
    );

    expect(model.stats.entities).toBe(3);
    expect(model.topCommunities[0]).toMatchObject({
      id: "comm:1",
      title: "Auth",
      count: 2,
    });
    expect(model.entityTypes).toEqual([
      { type: "MODULE", count: 2 },
      { type: "PERSON", count: 1 },
    ]);
  });
});
