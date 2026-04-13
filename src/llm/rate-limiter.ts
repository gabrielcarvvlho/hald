import { sleep } from "./retry.js";
import type { LLMProvider } from "./types.js";
import { logger } from "../shared/logger.js";

export const DEFAULT_RPM: Record<LLMProvider, number> = {
  anthropic: 40, // Tier 1 conservative
  openai: 200, // Tier 1 conservative
  google: 30, // Free tier conservative
  zhipu: 60, // Zhipu AI conservative
};

/**
 * Token bucket rate limiter.
 *
 * Tokens refill at a steady rate of `requestsPerMinute / 60` per second.
 * Burst capacity is 1 second worth of tokens: ceil(RPM / 60).
 * Concurrent callers queue via a promise chain — no token is double-spent.
 */
export class RateLimiter {
  private tokens: number;
  private readonly burstSize: number;
  private readonly refillIntervalMs: number;
  private lastRefillTime: number;
  /** Tail of the acquire chain — each caller appends to this. */
  private queue: Promise<void> = Promise.resolve();

  constructor(requestsPerMinute: number) {
    if (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) {
      throw new Error(`RateLimiter: requestsPerMinute must be positive, got ${requestsPerMinute}`);
    }
    this.burstSize = Math.ceil(requestsPerMinute / 60);
    this.tokens = this.burstSize;
    // Milliseconds between token refills (one token per interval)
    this.refillIntervalMs = 60_000 / requestsPerMinute;
    this.lastRefillTime = Date.now();

    logger.debug("RateLimiter created", {
      requestsPerMinute,
      burstSize: this.burstSize,
      refillIntervalMs: this.refillIntervalMs,
    });
  }

  /**
   * Acquire one token, waiting if the bucket is empty.
   * Safe for concurrent callers — requests are serialised via a promise chain.
   */
  acquire(): Promise<void> {
    // Append to the queue so each caller waits for the previous one to finish.
    this.queue = this.queue.then(() => this._acquireOne());
    return this.queue;
  }

  private async _acquireOne(): Promise<void> {
    this._refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Calculate how long until the next token arrives.
    const waitMs = this.refillIntervalMs - (Date.now() - this.lastRefillTime);
    logger.debug("RateLimiter: bucket empty, waiting", { waitMs: Math.round(waitMs) });
    await sleep(Math.max(0, waitMs));

    this._refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  /** Add tokens earned since last refill, capped at burstSize. */
  private _refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;
    const newTokens = Math.floor(elapsed / this.refillIntervalMs);
    if (newTokens > 0) {
      this.tokens = Math.min(this.burstSize, this.tokens + newTokens);
      this.lastRefillTime += newTokens * this.refillIntervalMs;
    }
  }
}
