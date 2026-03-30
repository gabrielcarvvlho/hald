import type { LLMClient, LLMRequestOptions, LLMResponse } from "./types.js";
import { logger } from "../shared/logger.js";

const DEFAULT_MODEL = "gemini-2.5-flash";

export class GoogleClient implements LLMClient {
  readonly provider = "google" as const;
  private sdk: InstanceType<
    typeof import("@google/genai").GoogleGenAI
  > | null = null;
  private apiKey: string;
  private model: string;
  private maxRetries: number;

  constructor(apiKey: string, model?: string, maxRetries = 3) {
    this.apiKey = apiKey;
    this.model = model ?? DEFAULT_MODEL;
    this.maxRetries = maxRetries;
  }

  private async getClient() {
    if (!this.sdk) {
      const { GoogleGenAI } = await import("@google/genai");
      this.sdk = new GoogleGenAI({ apiKey: this.apiKey });
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
        const response = await client.models.generateContent({
          model: this.model,
          contents: prompt,
          config: {
            systemInstruction: systemPrompt,
            temperature: options?.temperature ?? 0,
            maxOutputTokens: options?.maxTokens ?? 4096,
          },
        });

        return {
          text: response.text ?? "",
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
          model: this.model,
        };
      } catch (error: unknown) {
        const status = (error as { status?: number }).status;
        if (attempt < this.maxRetries && (status === 429 || (status && status >= 500))) {
          const delay = Math.pow(2, attempt) * 1000;
          logger.warn(
            `Google API error (attempt ${attempt + 1}/${this.maxRetries}), retrying in ${delay}ms`,
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
