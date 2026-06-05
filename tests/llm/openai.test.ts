import { describe, it, expect } from "vitest";
import { isReasoningModel } from "../../src/llm/openai.js";

describe("isReasoningModel", () => {
  it("treats the documented gpt-5 default family as reasoning models", () => {
    // gpt-5.4-mini is the OpenAI default (openai.ts) — it must omit temperature.
    expect(isReasoningModel("gpt-5.4-mini")).toBe(true);
    expect(isReasoningModel("gpt-5")).toBe(true);
    expect(isReasoningModel("GPT-5-Turbo")).toBe(true); // case-insensitive
  });

  it("treats the o-series as reasoning models", () => {
    expect(isReasoningModel("o1")).toBe(true);
    expect(isReasoningModel("o1-mini")).toBe(true);
    expect(isReasoningModel("o3")).toBe(true);
    expect(isReasoningModel("o4-mini")).toBe(true);
  });

  it("treats gpt-4o and OpenAI-compatible models as non-reasoning (temperature allowed)", () => {
    expect(isReasoningModel("gpt-4o")).toBe(false);
    expect(isReasoningModel("gpt-4o-mini")).toBe(false);
    expect(isReasoningModel("gpt-4-turbo")).toBe(false);
    expect(isReasoningModel("llama3.1")).toBe(false); // Ollama via HALD_BASE_URL
    expect(isReasoningModel("glm-4-flash")).toBe(false); // Zhipu
  });
});
