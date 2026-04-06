import { describe, it, expect } from "vitest";
import { parseSummaryXml, summarizeBatch } from "../../src/pipeline/summarizer.js";
import { EntityType, RelationType } from "../../src/shared/types.js";
import type { Community, Entity, Relation } from "../../src/shared/types.js";
import type { LLMClient, LLMResponse } from "../../src/llm/types.js";
import type { TokenAccumulator } from "../../src/pipeline/extractor.js";

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

describe("summarizer — ampersand sanitization retry", () => {
  it("handles bare ampersands in XML by sanitizing and retrying", () => {
    const xml = `<community_summary>
  <title>Auth & Payments</title>
  <summary>The auth & payments modules work together for billing & invoicing.</summary>
</community_summary>`;

    const result = parseSummaryXml(xml);
    expect(result.title).toBe("Auth & Payments");
    expect(result.summary).toContain("billing");
  });
});

describe("summarizer — XML fallback on parse failure", () => {
  it("returns raw text when XML is malformed", () => {
    const text = "Here is the summary: the payments team handles billing.";
    const result = parseSummaryXml(text);
    expect(result.title).toBe("");
    expect(result.summary).toBe(text);
  });

  it("returns raw text when XML tags are broken", () => {
    const text = "<community_summary><title>Broken</title><summary>Truncated";
    const result = parseSummaryXml(text);
    // No closing tag means extractXmlBlock returns null → falls back to raw text
    expect(result.title).toBe("");
    expect(result.summary).toBe(text);
  });

  it("returns raw text when response contains partial XML with preamble", () => {
    const text = "Here is what I found:\n\nThe billing team is responsible for invoicing.";
    const result = parseSummaryXml(text);
    expect(result.title).toBe("");
    expect(result.summary).toBe(text);
  });
});

describe("summarizer — batch summarization", () => {
  function createMockClient(responses: Map<string, string>): LLMClient {
    return {
      provider: "anthropic" as const,
      async extract(prompt: string): Promise<LLMResponse> {
        // Match by community ID presence in the prompt entities
        for (const [key, value] of responses) {
          if (prompt.includes(key)) {
            return {
              text: value,
              inputTokens: 100,
              outputTokens: 50,
              model: "mock",
              stopReason: "end_turn",
            };
          }
        }
        return {
          text: "<community_summary><title>Default</title><summary>Default summary</summary></community_summary>",
          inputTokens: 100,
          outputTokens: 50,
          model: "mock",
          stopReason: "end_turn",
        };
      },
    };
  }

  const sampleEntities: Entity[] = [
    {
      id: "person:alice",
      type: EntityType.PERSON,
      name: "Alice",
      aliases: [],
      description: "Developer",
      firstSeen: "2024-01-01",
      lastSeen: "2024-06-01",
      frequency: 5,
      metadata: {},
    },
    {
      id: "module:payments",
      type: EntityType.MODULE,
      name: "src/payments",
      aliases: [],
      description: "Payments module",
      firstSeen: "2024-01-01",
      lastSeen: "2024-06-01",
      frequency: 8,
      metadata: {},
    },
    {
      id: "module:billing",
      type: EntityType.MODULE,
      name: "src/billing",
      aliases: [],
      description: "Billing module",
      firstSeen: "2024-02-01",
      lastSeen: "2024-06-01",
      frequency: 4,
      metadata: {},
    },
  ];

  const sampleRelations: Relation[] = [
    {
      id: "rel:alice-payments",
      type: RelationType.AUTHORED,
      sourceId: "person:alice",
      targetId: "module:payments",
      weight: 9,
      description: "Alice authored payments",
      evidence: [],
      firstSeen: "2024-01-01",
      lastSeen: "2024-06-01",
    },
  ];

  it("summarizes multiple communities in parallel", async () => {
    const communities: Community[] = [
      {
        id: "comm:0:0",
        level: 0,
        title: "",
        summary: "",
        entityIds: ["person:alice", "module:payments"],
        childIds: [],
      },
      {
        id: "comm:0:1",
        level: 0,
        title: "",
        summary: "",
        entityIds: ["module:billing"],
        childIds: [],
      },
    ];

    const client = createMockClient(
      new Map([
        [
          "Alice",
          "<community_summary><title>Payments Team</title><summary>Alice works on payments.</summary></community_summary>",
        ],
        [
          "src/billing",
          "<community_summary><title>Billing</title><summary>The billing module.</summary></community_summary>",
        ],
      ]),
    );

    const tokenUsage: TokenAccumulator = {
      inputTokens: 0,
      outputTokens: 0,
      requestCount: 0,
      failedCount: 0,
    };

    const results: Array<{ communityId: string; title: string; summary: string }> = [];
    for await (const { communityId, result } of summarizeBatch(
      communities,
      sampleEntities,
      sampleRelations,
      client,
      { concurrency: 2, tokenUsage },
    )) {
      results.push({ communityId, title: result.title, summary: result.summary });
    }

    expect(results).toHaveLength(2);
    expect(results[0]!.communityId).toBe("comm:0:0");
    expect(results[0]!.title).toBe("Payments Team");
    expect(results[1]!.communityId).toBe("comm:0:1");
    expect(results[1]!.title).toBe("Billing");

    // Token usage should accumulate across both calls
    expect(tokenUsage.requestCount).toBe(2);
    expect(tokenUsage.inputTokens).toBe(200);
    expect(tokenUsage.outputTokens).toBe(100);
  });

  it("handles community with 0 members gracefully", async () => {
    const emptyCommunity: Community = {
      id: "comm:0:empty",
      level: 0,
      title: "",
      summary: "",
      entityIds: [],
      childIds: [],
    };

    const client = createMockClient(new Map());

    const results: Array<{ communityId: string }> = [];
    for await (const item of summarizeBatch(
      [emptyCommunity],
      sampleEntities,
      sampleRelations,
      client,
      { concurrency: 1 },
    )) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    expect(results[0]!.communityId).toBe("comm:0:empty");
  });

  it("handles relations referencing entities not in community", async () => {
    // Community only has billing, but relation references alice → payments
    const community: Community = {
      id: "comm:0:partial",
      level: 0,
      title: "",
      summary: "",
      entityIds: ["module:billing"],
      childIds: [],
    };

    // Relations reference entities outside the community — should still work
    const relationsWithDanglingRefs: Relation[] = [
      ...sampleRelations,
      {
        id: "rel:billing-payments",
        type: RelationType.DEPENDS_ON,
        sourceId: "module:billing",
        targetId: "module:nonexistent",
        weight: 5,
        description: "Billing depends on something missing",
        evidence: [],
        firstSeen: "2024-01-01",
        lastSeen: "2024-06-01",
      },
    ];

    const client = createMockClient(new Map());

    const results: Array<{ communityId: string }> = [];
    for await (const item of summarizeBatch(
      [community],
      sampleEntities,
      relationsWithDanglingRefs,
      client,
      { concurrency: 1 },
    )) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    expect(results[0]!.communityId).toBe("comm:0:partial");
  });

  it("handles LLM failure gracefully (returns empty result)", async () => {
    const community: Community = {
      id: "comm:0:fail",
      level: 0,
      title: "",
      summary: "",
      entityIds: ["person:alice"],
      childIds: [],
    };

    const failingClient: LLMClient = {
      provider: "anthropic" as const,
      async extract(): Promise<LLMResponse> {
        throw new Error("LLM API error");
      },
    };

    const tokenUsage: TokenAccumulator = {
      inputTokens: 0,
      outputTokens: 0,
      requestCount: 0,
      failedCount: 0,
    };

    const results: Array<{ communityId: string; title: string; summary: string }> = [];
    for await (const { communityId, result } of summarizeBatch(
      [community],
      sampleEntities,
      sampleRelations,
      failingClient,
      { concurrency: 1, tokenUsage },
    )) {
      results.push({ communityId, title: result.title, summary: result.summary });
    }

    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("");
    expect(results[0]!.summary).toBe("");
    expect(tokenUsage.failedCount).toBe(1);
  });
});
