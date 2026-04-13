import type { LLMClient, LLMClientConfig, LLMProvider } from "./types.js";
import { logger } from "../shared/logger.js";
import { RateLimiter, DEFAULT_RPM } from "./rate-limiter.js";
import { RateLimitedClient } from "./rate-limited-client.js";

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
  if (process.env.ZHIPU_API_KEY) {
    return { provider: "zhipu", apiKey: process.env.ZHIPU_API_KEY };
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
    case "zhipu":
      return process.env.ZHIPU_API_KEY;
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
        "No LLM API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, or ZHIPU_API_KEY. " +
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

  let inner: LLMClient;

  switch (provider) {
    case "anthropic": {
      const { AnthropicClient } = await import("./anthropic.js");
      inner = new AnthropicClient(apiKey, config.model, config.baseUrl, config.maxRetries);
      break;
    }
    case "openai": {
      const { OpenAIClient } = await import("./openai.js");
      inner = new OpenAIClient(apiKey, config.model, config.baseUrl, config.maxRetries);
      break;
    }
    case "google": {
      const { GoogleClient } = await import("./google.js");
      inner = new GoogleClient(apiKey, config.model, config.maxRetries);
      break;
    }
    case "zhipu": {
      // Zhipu AI (z.ai) GLM models — OpenAI-compatible API
      const { OpenAIClient } = await import("./openai.js");
      inner = new OpenAIClient(
        apiKey,
        config.model ?? "glm-4-flash",
        config.baseUrl ?? "https://open.bigmodel.cn/api/paas/v4/",
        config.maxRetries,
      );
      break;
    }
  }

  const rawRpm = process.env.HALD_RATE_LIMIT !== undefined
    ? Number(process.env.HALD_RATE_LIMIT)
    : DEFAULT_RPM[provider];
  const rpm = Number.isFinite(rawRpm) && rawRpm > 0 ? rawRpm : DEFAULT_RPM[provider];

  if (rawRpm !== rpm) {
    logger.warn("Invalid HALD_RATE_LIMIT, using default", {
      raw: process.env.HALD_RATE_LIMIT,
      fallback: rpm,
    });
  }

  logger.debug("Wrapping client with RateLimiter", { provider, rpm });
  const limiter = new RateLimiter(rpm);
  return new RateLimitedClient(inner, limiter);
}
