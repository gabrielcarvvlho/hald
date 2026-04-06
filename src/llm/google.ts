import type { LLMClient, LLMRequestOptions, LLMResponse } from "./types.js";
import { withRetry } from "./retry.js";

const REQUEST_TIMEOUT_MS = 120_000;

const DEFAULT_MODEL = "gemini-2.5-flash";

export class GoogleClient implements LLMClient {
  readonly provider = "google" as const;
  private sdk: InstanceType<typeof import("@google/genai").GoogleGenAI> | null = null;
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

    return withRetry(
      async () => {
        // Google SDK has no constructor-level timeout — use AbortController
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
          const response = await client.models.generateContent({
            model: this.model,
            contents: prompt,
            config: {
              systemInstruction: systemPrompt,
              temperature: options?.temperature ?? 0,
              maxOutputTokens: options?.maxTokens ?? 4096,
              abortSignal: controller.signal,
            },
          });

          const finishReason = response.candidates?.[0]?.finishReason;
          return {
            text: response.text ?? "",
            inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
            model: this.model,
            stopReason:
              finishReason === "STOP"
                ? "end_turn"
                : finishReason === "MAX_TOKENS"
                  ? "max_tokens"
                  : (finishReason?.toLowerCase() ?? "unknown"),
          };
        } finally {
          clearTimeout(timeoutId);
        }
      },
      this.maxRetries,
      "Google API",
    );
  }
}
