import type { LLMClient, LLMRequestOptions, LLMResponse } from "./types.js";
import { logger } from "../shared/logger.js";

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

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
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
      } catch (error: unknown) {
        const status = (error as { status?: number }).status;
        if (attempt < this.maxRetries && (status === 429 || (status && status >= 500))) {
          const baseDelay = Math.pow(2, attempt) * 1000;
          const delay = baseDelay + Math.random() * baseDelay * 0.5;
          logger.warn(
            `Anthropic API error (attempt ${attempt + 1}/${this.maxRetries}), retrying in ${Math.round(delay)}ms`,
            { status, error: String(error) },
          );
          await sleep(delay);
          continue;
        }
        throw error;
      }
    }

    throw new Error("Exhausted retries");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
