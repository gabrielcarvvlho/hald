import { describe, it, expect } from "vitest";
import { parseSummaryXml } from "../../src/pipeline/summarizer.js";

describe("summarizer — XML parsing", () => {
  it("parses a well-formed community summary", () => {
    const xml = `
<community_summary>
  <title>Payments Service & gRPC Migration</title>
  <summary>
  This community covers the payments module migration from REST to gRPC.
  Alice Chen led the effort, with Bob updating the billing integration.
  </summary>
</community_summary>`;

    const result = parseSummaryXml(xml);

    expect(result.title).toBe("Payments Service & gRPC Migration");
    expect(result.summary).toContain("payments module migration");
    expect(result.summary).toContain("Alice Chen");
  });

  it("handles XML wrapped in preamble", () => {
    const text = `Here is the summary:

<community_summary>
  <title>Auth Middleware</title>
  <summary>Handles authentication.</summary>
</community_summary>

Hope this helps!`;

    const result = parseSummaryXml(text);
    expect(result.title).toBe("Auth Middleware");
    expect(result.summary).toBe("Handles authentication.");
  });

  it("falls back to raw text when no XML", () => {
    const text = "This is a plain text summary without XML tags.";
    const result = parseSummaryXml(text);
    expect(result.title).toBe("");
    expect(result.summary).toBe(text);
  });

  it("handles empty summary", () => {
    const xml = `<community_summary>
  <title>Empty</title>
  <summary></summary>
</community_summary>`;

    const result = parseSummaryXml(xml);
    expect(result.title).toBe("Empty");
    expect(result.summary).toBe("");
  });
});
