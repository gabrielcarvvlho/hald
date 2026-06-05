import type { LLMClient, LLMRequestOptions, LLMResponse } from "./types.js";
import { withRetry } from "./retry.js";

const DEFAULT_MODEL = "gpt-5.4-mini";

/**
 * GPT-5 and the o-series are reasoning models that only accept the default
 * temperature of 1 — passing any explicit temperature returns a 400. Detect
 * them by name so we can omit the parameter (mirrors the `max_completion_tokens`
 * handling below). gpt-4o and OpenAI-compatible endpoints (Ollama, Zhipu, …)
 * keep deterministic `temperature: 0`.
 */
export function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.startsWith("gpt-5") || /^o\d/.test(m);
}

export class OpenAIClient implements LLMClient {
  readonly provider = "openai" as const;
  private sdk: InstanceType<typeof import("openai").default> | null = null;
  private apiKey: string;
  private model: string;
  private baseUrl?: string;
  private maxRetries: number;

  constructor(apiKey: string, model?: string, baseUrl?: string, maxRetries = 3) {
    this.apiKey = apiKey;
    this.model = model ?? DEFAULT_MODEL;
    this.baseUrl = baseUrl;
    this.maxRetries = maxRetries;
  }

  private async getClient() {
    if (!this.sdk) {
      const OpenAI = (await import("openai")).default;
      this.sdk = new OpenAI({
        apiKey: this.apiKey,
        maxRetries: 0, // We manage retries ourselves — prevent double-retry amplification
        timeout: 120_000,
        ...(this.baseUrl && { baseURL: this.baseUrl }),
      });
    }
    return this.sdk;
  }

  async extract(
    prompt: string,
    systemPrompt: string,
    options?: LLMRequestOptions,
  ): Promise<LLMResponse> {
    const client = await this.getClient();

    return withRetry(
      async () => {
        const response = await client.chat.completions.create({
          model: this.model,
          // Reasoning models reject an explicit temperature; see isReasoningModel.
          ...(isReasoningModel(this.model) ? {} : { temperature: options?.temperature ?? 0 }),
          // GPT-5 / o1 family rejected the legacy `max_tokens`. Use
          // `max_completion_tokens` — canonical since o1 (late 2024) and
          // accepted by gpt-4o family too. If you hit a third-party
          // OpenAI-compatible endpoint that requires `max_tokens`, set
          // HALD_MODEL to a model name that endpoint understands.
          max_completion_tokens: options?.maxTokens ?? 4096,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
        });

        const finishReason = response.choices[0]?.finish_reason;
        return {
          text: response.choices[0]?.message?.content ?? "",
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          model: response.model,
          stopReason:
            finishReason === "stop"
              ? "end_turn"
              : finishReason === "length"
                ? "max_tokens"
                : (finishReason ?? "unknown"),
        };
      },
      this.maxRetries,
      "OpenAI API",
    );
  }
}
