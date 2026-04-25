import { describe, it, expect } from "vitest";
// @ts-expect-error — JS module without types, intentional (frontend ESM)
import { parseHash, serializeState } from "../../src/viz/public/url-state.js";

// ================================================================
// URL state — parseHash and serializeState are the only contract
// that ties a copy-pasted URL to a restored viz view. Test the
// shape and the round-trip property.
// ================================================================

describe("parseHash", () => {
  it("returns empty state for empty hash", () => {
    expect(parseHash("")).toEqual({ hide: [] });
  });

  it("returns empty state for bare '#'", () => {
    expect(parseHash("#")).toEqual({ hide: [] });
  });

  it("returns empty state for null/undefined input without throwing", () => {
    expect(parseHash(null)).toEqual({ hide: [] });
    expect(parseHash(undefined)).toEqual({ hide: [] });
  });

  it("parses a node id", () => {
    expect(parseHash("#node=abc")).toEqual({ node: "abc", hide: [] });
  });

  it("parses a hide list", () => {
    expect(parseHash("#hide=PERSON,MODULE")).toEqual({
      hide: ["PERSON", "MODULE"],
    });
  });

  it("parses combined node and hide", () => {
    expect(parseHash("#node=abc&hide=PERSON,MODULE")).toEqual({
      node: "abc",
      hide: ["PERSON", "MODULE"],
    });
  });

  it("decodes URI components in node id (colons, slashes, etc.)", () => {
    const id = "module:auth-service/v2";
    expect(parseHash("#node=" + encodeURIComponent(id))).toEqual({
      node: id,
      hide: [],
    });
  });

  it("decodes URI components in hide values", () => {
    expect(parseHash("#hide=" + encodeURIComponent("FOO BAR") + ",BAZ")).toEqual({
      hide: ["FOO BAR", "BAZ"],
    });
  });

  it("survives malformed parts and salvages valid ones", () => {
    expect(parseHash("#garbage&%bad&node=ok")).toEqual({
      node: "ok",
      hide: [],
    });
  });

  it("ignores keys without =", () => {
    expect(parseHash("#standalone&node=ok")).toEqual({
      node: "ok",
      hide: [],
    });
  });

  it("ignores keys other than node and hide", () => {
    expect(parseHash("#node=ok&random=ignored&junk=value")).toEqual({
      node: "ok",
      hide: [],
    });
  });

  it("handles empty hide list (hide=)", () => {
    expect(parseHash("#hide=")).toEqual({ hide: [] });
  });

  it("filters empty entries in hide list", () => {
    expect(parseHash("#hide=,A,,B,")).toEqual({ hide: ["A", "B"] });
  });
});

describe("serializeState", () => {
  it("returns empty string for empty state", () => {
    expect(serializeState({ hide: [] })).toBe("");
    expect(serializeState({})).toBe("");
  });

  it("returns empty string for null/undefined", () => {
    expect(serializeState(null)).toBe("");
    expect(serializeState(undefined)).toBe("");
  });

  it("serializes node only", () => {
    expect(serializeState({ node: "abc", hide: [] })).toBe("node=abc");
  });

  it("serializes hide only", () => {
    expect(serializeState({ hide: ["PERSON", "MODULE"] })).toBe(
      "hide=PERSON,MODULE",
    );
  });

  it("serializes both node and hide", () => {
    expect(serializeState({ node: "abc", hide: ["PERSON"] })).toBe(
      "node=abc&hide=PERSON",
    );
  });

  it("encodes special characters in node id", () => {
    expect(serializeState({ node: "module:auth/v2", hide: [] })).toBe(
      "node=module%3Aauth%2Fv2",
    );
  });

  it("encodes special characters in hide values", () => {
    expect(serializeState({ hide: ["FOO BAR", "BAZ"] })).toBe(
      "hide=FOO%20BAR,BAZ",
    );
  });
});

describe("roundtrip parseHash(serializeState(s)) === s", () => {
  const cases = [
    { hide: [] },
    { node: "abc", hide: [] },
    { hide: ["A", "B"] },
    { node: "module:auth/v2", hide: ["PERSON", "TECHNOLOGY"] },
    { node: "id with spaces", hide: ["TYPE WITH SPACES"] },
  ];
  for (const s of cases) {
    it("preserves: " + JSON.stringify(s), () => {
      const round = parseHash("#" + serializeState(s));
      expect(round).toEqual(s);
    });
  }
});
