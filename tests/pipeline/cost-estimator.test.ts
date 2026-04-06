import { describe, it, expect } from "vitest";
import {
  estimateCost,
  estimateCommunityCount,
  calculateActualCost,
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
    const textUnits = [makeTextUnit("a".repeat(2000)), makeTextUnit("b".repeat(2000))];

    const anthropicCost = estimateCost(textUnits, 3, "anthropic");
    const googleCost = estimateCost(textUnits, 3, "google");

    expect(anthropicCost.estimatedCostUsd).toBeGreaterThan(googleCost.estimatedCostUsd);
  });

  it("returns zero-ish cost for small inputs", () => {
    const textUnits = [makeTextUnit("hello world")];
    const cost = estimateCost(textUnits, 1, "google");

    expect(cost.estimatedCostUsd).toBeLessThan(0.01);
    expect(cost.totalTokens).toBeGreaterThan(0);
  });

  it("scales linearly with text units", () => {
    const small = estimateCost([makeTextUnit("x".repeat(1000))], 1, "anthropic");
    const large = estimateCost(
      Array.from({ length: 10 }, () => makeTextUnit("x".repeat(1000))),
      5,
      "anthropic",
    );

    expect(large.estimatedCostUsd).toBeGreaterThan(small.estimatedCostUsd * 5);
  });

  it("includes extraction and summarization breakdown", () => {
    const cost = estimateCost([makeTextUnit("test content")], 2, "openai");

    expect(cost.extractionTokens).toBeGreaterThan(0);
    expect(cost.summarizationTokens).toBeGreaterThan(0);
    expect(cost.breakdown.extraction).toContain("tokens");
    expect(cost.breakdown.summarization).toContain("tokens");
    expect(cost.breakdown.total).toContain("$");
  });

  it("includes ~40% gleaning buffer in extraction tokens", () => {
    const textUnits = [makeTextUnit("a".repeat(1000))];
    const cost = estimateCost(textUnits, 0, "anthropic");

    // Base without gleaning: estimateTokens("a"*1000) + 600 + 500 = ~250 + 600 + 500 = 1350
    // With 1.4x gleaning multiplier: ~1890
    // Assert within a tight range to catch both removal and wrong multiplier
    const baseTokens = 1350;
    expect(cost.extractionTokens).toBeGreaterThan(baseTokens * 1.3);
    expect(cost.extractionTokens).toBeLessThan(baseTokens * 1.5);
  });

  it("falls back to anthropic rates for unknown provider", () => {
    const cost = estimateCost([makeTextUnit("test")], 1, "ollama");
    expect(cost.estimatedCostUsd).toBeGreaterThan(0);
    expect(cost.provider).toBe("ollama");
  });
});

describe("calculateActualCost", () => {
  it("calculates cost from real token counts with known model", () => {
    // Claude Sonnet: $3/1M input, $15/1M output
    const result = calculateActualCost(100_000, 50_000, "anthropic", "claude-sonnet-4-20250514");
    expect(result.costUsd).toBeCloseTo(0.3 + 0.75, 4); // 1.05
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.provider).toBe("anthropic");
  });

  it("uses provider-level fallback for unknown model", () => {
    const result = calculateActualCost(1_000_000, 500_000, "anthropic", "claude-unknown-model");
    // Falls back to anthropic provider rate: $3/1M input, $15/1M output
    expect(result.costUsd).toBeCloseTo(3.0 + 7.5, 4);
  });

  it("uses default model when none specified", () => {
    const result = calculateActualCost(1_000_000, 0, "openai");
    // Default openai model is gpt-4.1-mini: $0.4/1M input
    expect(result.costUsd).toBeCloseTo(0.4, 4);
    expect(result.model).toBe("gpt-4.1-mini");
  });

  it("returns zero cost for zero tokens", () => {
    const result = calculateActualCost(0, 0, "anthropic");
    expect(result.costUsd).toBe(0);
  });

  it("returns zero cost for unknown provider with no model", () => {
    const result = calculateActualCost(1_000_000, 1_000_000, "ollama");
    expect(result.costUsd).toBe(0);
    expect(result.model).toBe("unknown");
  });

  it("Google Gemini Flash is cheapest among defaults", () => {
    const tokens = { input: 500_000, output: 200_000 };
    const anthropic = calculateActualCost(tokens.input, tokens.output, "anthropic");
    const openai = calculateActualCost(tokens.input, tokens.output, "openai");
    const google = calculateActualCost(tokens.input, tokens.output, "google");

    expect(google.costUsd).toBeLessThan(openai.costUsd);
    expect(openai.costUsd).toBeLessThan(anthropic.costUsd);
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
