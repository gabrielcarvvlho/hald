import { estimateTokens } from "./chunker.js";
import type { TextUnit } from "../shared/types.js";

// ================================================================
// Cost per 1M tokens by provider (input + output combined estimate)
// ================================================================

const COST_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  anthropic: { input: 3.0, output: 15.0 }, // Claude Sonnet
  openai: { input: 0.4, output: 1.6 }, // GPT-4.1-mini
  google: { input: 0.15, output: 0.6 }, // Gemini Flash
};

/** Per-model pricing (USD per 1M tokens). Used for actual cost calculation. */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4.0 },
  // OpenAI
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  // Google
  "gemini-2.5-flash": { input: 0.15, output: 0.6 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
};

/** Default model for each provider — used when model is not specified. */
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4.1-mini",
  google: "gemini-2.5-flash",
};

export interface CostEstimate {
  provider: string;
  extractionTokens: number;
  summarizationTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  breakdown: {
    extraction: string;
    summarization: string;
    total: string;
  };
}

/**
 * Estimate the cost of indexing before running the pipeline.
 * Uses rough token estimates based on text unit content length.
 */
export function estimateCost(
  textUnits: TextUnit[],
  estimatedCommunities: number,
  provider: string,
): CostEstimate {
  // Extraction: ~500 tokens per text unit (input) + ~500 tokens output
  const extractionInputTokens = textUnits.reduce(
    (sum, tu) => sum + estimateTokens(tu.content),
    0,
  );
  // System prompt is ~600 tokens, added per call
  const systemPromptTokens = 600 * textUnits.length;
  const extractionOutputTokens = textUnits.length * 500; // estimated output
  const extractionTokens =
    extractionInputTokens + systemPromptTokens + extractionOutputTokens;

  // Summarization: ~300 tokens per community (input context + output)
  const summarizationTokens = estimatedCommunities * 800; // input + output

  const totalTokens = extractionTokens + summarizationTokens;

  const rates = COST_PER_1M_TOKENS[provider] ?? COST_PER_1M_TOKENS.anthropic!;

  // Rough split: 60% input, 40% output for extraction
  const inputTokens = totalTokens * 0.6;
  const outputTokens = totalTokens * 0.4;
  const estimatedCostUsd =
    (inputTokens / 1_000_000) * rates.input +
    (outputTokens / 1_000_000) * rates.output;

  return {
    provider,
    extractionTokens,
    summarizationTokens,
    totalTokens,
    estimatedCostUsd,
    breakdown: {
      extraction: `~${extractionTokens.toLocaleString()} tokens (${textUnits.length} text units)`,
      summarization: `~${summarizationTokens.toLocaleString()} tokens (~${estimatedCommunities} communities)`,
      total: `~${totalTokens.toLocaleString()} tokens ≈ $${estimatedCostUsd.toFixed(2)}`,
    },
  };
}

/**
 * Estimate how many communities will be produced from a given number of entities.
 * Rough heuristic: 1 community per 4-6 entities (at the finest resolution).
 */
export function estimateCommunityCount(entityCount: number): number {
  return Math.max(1, Math.round(entityCount / 5));
}

/**
 * Format cost estimate for CLI display.
 */
export function formatCostEstimate(estimate: CostEstimate): string {
  const lines = [
    `  Provider:       ${estimate.provider}`,
    `  Extraction:     ${estimate.breakdown.extraction}`,
    `  Summarization:  ${estimate.breakdown.summarization}`,
    `  Total:          ${estimate.breakdown.total}`,
  ];

  if (estimate.provider === "google") {
    lines.push(`  (Google Gemini Flash — lowest cost)`);
  } else if (estimate.provider === "openai") {
    lines.push(`  (OpenAI GPT-4.1-mini)`);
  } else if (estimate.provider === "anthropic") {
    lines.push(`  (Anthropic Claude Sonnet)`);
  }

  return lines.join("\n");
}

// ================================================================
// Actual cost calculation (post-indexing, using real token counts)
// ================================================================

export interface ActualCostResult {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Calculate actual cost from real token counts after indexing.
 * Uses per-model pricing when available, falls back to provider-level rates.
 */
export function calculateActualCost(
  inputTokens: number,
  outputTokens: number,
  provider: string,
  model?: string,
): ActualCostResult {
  const resolvedModel = model ?? DEFAULT_MODELS[provider] ?? "unknown";
  const rates =
    MODEL_PRICING[resolvedModel] ??
    COST_PER_1M_TOKENS[provider] ??
    { input: 0, output: 0 };

  const costUsd =
    (inputTokens / 1_000_000) * rates.input +
    (outputTokens / 1_000_000) * rates.output;

  return {
    provider,
    model: resolvedModel,
    inputTokens,
    outputTokens,
    costUsd,
  };
}
