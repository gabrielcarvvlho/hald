import { describe, it, expect } from "vitest";
import {
  estimateCost,
  estimateCommunityCount,
} from "../../src/pipeline/cost-estimator.js";
import type { TextUnit } from "../../src/shared/types.js";

function makeTextUnit(content: string): TextUnit {
  return {
    id: "tu:test",
    content,
    commitHashes: ["abc"],
    dateRange: { start: "2024-01-01", end: "2024-01-01" },
    entityIds: [],
    relationIds: [],
  };
}

describe("estimateCost", () => {
  it("returns higher cost for Anthropic than Google", () => {
    const textUnits = [
      makeTextUnit("a".repeat(2000)),
      makeTextUnit("b".repeat(2000)),
    ];

    const anthropicCost = estimateCost(textUnits, 3, "anthropic");
    const googleCost = estimateCost(textUnits, 3, "google");

    expect(anthropicCost.estimatedCostUsd).toBeGreaterThan(
      googleCost.estimatedCostUsd,
    );
  });

  it("returns zero-ish cost for small inputs", () => {
    const textUnits = [makeTextUnit("hello world")];
    const cost = estimateCost(textUnits, 1, "google");

    expect(cost.estimatedCostUsd).toBeLessThan(0.01);
    expect(cost.totalTokens).toBeGreaterThan(0);
  });

  it("scales linearly with text units", () => {
    const small = estimateCost(
      [makeTextUnit("x".repeat(1000))],
      1,
      "anthropic",
    );
    const large = estimateCost(
      Array.from({ length: 10 }, () => makeTextUnit("x".repeat(1000))),
      5,
      "anthropic",
    );

    expect(large.estimatedCostUsd).toBeGreaterThan(
      small.estimatedCostUsd * 5,
    );
  });

  it("includes extraction and summarization breakdown", () => {
    const cost = estimateCost(
      [makeTextUnit("test content")],
      2,
      "openai",
    );

    expect(cost.extractionTokens).toBeGreaterThan(0);
    expect(cost.summarizationTokens).toBeGreaterThan(0);
    expect(cost.breakdown.extraction).toContain("tokens");
    expect(cost.breakdown.summarization).toContain("tokens");
    expect(cost.breakdown.total).toContain("$");
  });

  it("falls back to anthropic rates for unknown provider", () => {
    const cost = estimateCost([makeTextUnit("test")], 1, "ollama");
    expect(cost.estimatedCostUsd).toBeGreaterThan(0);
    expect(cost.provider).toBe("ollama");
  });
});

describe("estimateCommunityCount", () => {
  it("estimates ~1 community per 5 entities", () => {
    expect(estimateCommunityCount(10)).toBe(2);
    expect(estimateCommunityCount(25)).toBe(5);
  });

  it("returns at least 1", () => {
    expect(estimateCommunityCount(1)).toBe(1);
    expect(estimateCommunityCount(0)).toBe(1);
  });
});
