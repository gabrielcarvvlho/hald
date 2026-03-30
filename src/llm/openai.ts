import type { LLMClient, LLMRequestOptions, LLMResponse } from "./types.js";
import { logger } from "../shared/logger.js";

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
        const response = await client.chat.completions.create({
          model: this.model,
          temperature: options?.temperature ?? 0,
          max_tokens: options?.maxTokens ?? 4096,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
        });

        return {
          text: response.choices[0]?.message?.content ?? "",
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          model: response.model,
        };
      } catch (error: unknown) {
        const status = (error as { status?: number }).status;
        if (attempt < this.maxRetries && (status === 429 || (status && status >= 500))) {
          const delay = Math.pow(2, attempt) * 1000;
          logger.warn(
            `OpenAI API error (attempt ${attempt + 1}/${this.maxRetries}), retrying in ${delay}ms`,
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
