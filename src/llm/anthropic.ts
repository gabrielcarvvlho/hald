import type { LLMClient, LLMRequestOptions, LLMResponse } from "./types.js";
import { withRetry } from "./retry.js";

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

export class AnthropicClient implements LLMClient {
  readonly provider = "anthropic" as const;
  private sdk: InstanceType<typeof import("@anthropic-ai/sdk").default> | null =
    null;
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
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      this.sdk = new Anthropic({
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
        const response = await client.messages.create({
          model: this.model,
          max_tokens: options?.maxTokens ?? 4096,
          temperature: options?.temperature ?? 0,
          system: systemPrompt,
          messages: [{ role: "user", content: prompt }],
        });

        const text =
          response.content[0]?.type === "text"
            ? response.content[0].text
            : "";

        return {
          text,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          model: response.model,
          stopReason: response.stop_reason ?? "unknown",
        };
      },
      this.maxRetries,
      "Anthropic API",
    );
  }
}
