import type { LLMClient, LLMProvider, LLMRequestOptions, LLMResponse } from "./types.js";
import type { RateLimiter } from "./rate-limiter.js";

/**
 * Decorates any LLMClient with proactive rate limiting via a token bucket.
 * Transparent to callers — implements the same LLMClient interface.
 */
export class RateLimitedClient implements LLMClient {
  constructor(
    private readonly inner: LLMClient,
    private readonly limiter: RateLimiter,
  ) {}

  get provider(): LLMProvider {
    return this.inner.provider;
  }

  async extract(
    prompt: string,
    systemPrompt: string,
    options?: LLMRequestOptions,
  ): Promise<LLMResponse> {
    await this.limiter.acquire();
    return this.inner.extract(prompt, systemPrompt, options);
  }
}
