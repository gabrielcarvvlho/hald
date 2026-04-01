export type LLMProvider = "anthropic" | "openai" | "google";

export interface LLMClient {
  readonly provider: LLMProvider;

  /** Send an extraction request. Returns the raw text response. */
  extract(
    prompt: string,
    systemPrompt: string,
    options?: LLMRequestOptions,
  ): Promise<LLMResponse>;
}

export interface LLMRequestOptions {
  temperature?: number; // Default: 0 (deterministic extraction)
  maxTokens?: number; // Default: 4096
}

export interface LLMResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  stopReason: string; // "end_turn" | "max_tokens" | provider-specific
}

export interface LLMClientConfig {
  provider: LLMProvider | "auto";
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxRetries: number;
}
