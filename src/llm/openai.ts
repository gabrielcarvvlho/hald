import type { LLMClient, LLMRequestOptions, LLMResponse } from "./types.js";
import { withRetry } from "./retry.js";

const DEFAULT_MODEL = "gpt-4.1-mini";

export class OpenAIClient implements LLMClient {
  readonly provider = "openai" as const;
  private sdk: InstanceType<typeof import("openai").default> | null = null;
  private apiKey: string;
  private model: string;
  private baseUrl?: string;
  private maxRetries: number;

  constructor(
    apiKey: string,
    model?: string,
    baseUrl?: string,
    maxRetries = 3,
  ) {
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
          temperature: options?.temperature ?? 0,
          max_tokens: options?.maxTokens ?? 4096,
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
                : finishReason ?? "unknown",
        };
      },
      this.maxRetries,
      "OpenAI API",
    );
  }
}
