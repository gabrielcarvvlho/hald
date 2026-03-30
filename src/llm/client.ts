import type { LLMClient, LLMClientConfig, LLMProvider } from "./types.js";
import { logger } from "../shared/logger.js";

export class NoProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoProviderError";
  }
}

/**
 * Detect which LLM provider is available from environment variables.
 * Priority: Anthropic → OpenAI → Google
 */
export function detectProvider(): {
  provider: LLMProvider;
  apiKey: string;
} | null {
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: "openai", apiKey: process.env.OPENAI_API_KEY };
  }
  const googleKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (googleKey) {
    return { provider: "google", apiKey: googleKey };
  }
  return null;
}

/** Look up the expected env var for a specific provider. */
function getApiKeyForProvider(provider: LLMProvider): string | undefined {
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "google":
      return process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  }
}

/**
 * Create an LLM client based on config.
 * When provider is "auto", detects from environment variables.
 * Lazy-imports only the needed provider SDK.
 */
export async function createClient(config: LLMClientConfig): Promise<LLMClient> {
  let provider: LLMProvider;
  let apiKey: string | undefined = config.apiKey;

  if (config.provider === "auto") {
    const detected = detectProvider();
    if (!detected) {
      throw new NoProviderError(
        "No LLM API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY. " +
          "Alternatively, run indexing via the MCP tool from your coding agent.",
      );
    }
    provider = detected.provider;
    apiKey = apiKey ?? detected.apiKey;
  } else {
    provider = config.provider;
    // When provider is explicit but apiKey wasn't passed, try the env var
    if (!apiKey) {
      apiKey = getApiKeyForProvider(provider);
    }
  }

  if (!apiKey) {
    throw new NoProviderError(
      `No API key provided for ${provider}. Set the appropriate environment variable.`,
    );
  }

  logger.info("Creating LLM client", { provider, model: config.model });

  switch (provider) {
    case "anthropic": {
      const { AnthropicClient } = await import("./anthropic.js");
      return new AnthropicClient(
        apiKey,
        config.model,
        config.baseUrl,
        config.maxRetries,
      );
    }
    case "openai": {
      const { OpenAIClient } = await import("./openai.js");
      return new OpenAIClient(
        apiKey,
        config.model,
        config.baseUrl,
        config.maxRetries,
      );
    }
    case "google": {
      const { GoogleClient } = await import("./google.js");
      return new GoogleClient(apiKey, config.model, config.maxRetries);
    }
  }
}
