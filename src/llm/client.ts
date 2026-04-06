import type { LLMClient, LLMClientConfig, LLMProvider } from "./types.js";
import { logger } from "../shared/logger.js";

export class NoProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoProviderError";
  }
}

/**
 * Infer which host agent is running us from platform-specific env vars.
 * Returns the provider that matches the host agent, or null if unknown.
 */
function detectHostAgent(): LLMProvider | null {
  if (process.env.CLAUDE_PLUGIN_ROOT) return "anthropic";
  if (process.env.CURSOR_PLUGIN_ROOT) return "openai";
  // Gemini CLI doesn't set a plugin root, but if GEMINI_API_KEY is present
  // without Anthropic/OpenAI keys, the fallback order below handles it.
  return null;
}

/**
 * Detect which LLM provider is available from environment variables.
 *
 * Strategy:
 *   1. If we detect a host agent (Claude Code, Cursor), prefer that agent's
 *      native provider — avoids surprise cross-provider billing.
 *   2. Fall back to priority order: Anthropic → OpenAI → Google.
 */
export function detectProvider(): {
  provider: LLMProvider;
  apiKey: string;
} | null {
  // 1. Host-agent-aware: match the provider to the platform running us
  const hostHint = detectHostAgent();
  if (hostHint) {
    const key = getApiKeyForProvider(hostHint);
    if (key) {
      logger.debug("Provider auto-detected from host agent", {
        host: hostHint,
      });
      return { provider: hostHint, apiKey: key };
    }
  }

  // 2. Fallback: first available key wins
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
      return new AnthropicClient(apiKey, config.model, config.baseUrl, config.maxRetries);
    }
    case "openai": {
      const { OpenAIClient } = await import("./openai.js");
      return new OpenAIClient(apiKey, config.model, config.baseUrl, config.maxRetries);
    }
    case "google": {
      const { GoogleClient } = await import("./google.js");
      return new GoogleClient(apiKey, config.model, config.maxRetries);
    }
  }
}
