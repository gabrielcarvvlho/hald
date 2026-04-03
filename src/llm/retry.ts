import { logger } from "../shared/logger.js";

/**
 * Determine whether an error from an LLM SDK is retryable.
 *
 * Retryable:  429 (rate limit), 5xx (server errors), connection/timeout errors.
 * Non-retryable: 400 (bad request), 401 (auth), 403, 404, 422 (validation).
 */
export function isRetryableError(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  if (status === 429 || (status !== undefined && status >= 500)) return true;

  // Network failures — SDK wraps these with no status code
  const name = (error as { name?: string }).name;
  if (
    name === "APIConnectionError" ||
    name === "APIConnectionTimeoutError"
  ) {
    return true;
  }

  // Node.js-level network errors (Google SDK, custom endpoints)
  const code = (error as { code?: string }).code;
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return true;
  }

  // AbortError from our own timeout controller
  if (name === "AbortError") return true;

  return false;
}

/**
 * Read a header value from an error's headers, handling both plain Record
 * (Anthropic/OpenAI SDKs) and fetch Headers objects (Google SDK).
 */
function getHeader(
  error: unknown,
  name: string,
): string | null | undefined {
  const headers = (error as { headers?: unknown }).headers;
  if (!headers) return undefined;

  // Fetch Headers object — use .get()
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get: (n: string) => string | null }).get(name);
  }

  // Plain Record (Anthropic/OpenAI SDK Headers type)
  return (headers as Record<string, string | null | undefined>)[name];
}

/**
 * Parse the Retry-After header value (seconds or HTTP-date) into milliseconds.
 * Returns 0 if the header is absent, null, or unparseable.
 */
function parseRetryAfter(value: string | null | undefined): number {
  if (!value) return 0;

  // Try as seconds first (most common from LLM providers)
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  // Try as HTTP-date (e.g., "Thu, 01 Dec 2025 16:00:00 GMT")
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }

  return 0;
}

/**
 * Calculate retry delay, respecting the server's Retry-After header when present.
 * Uses exponential backoff with jitter as the baseline.
 */
export function calculateDelay(attempt: number, error: unknown): number {
  const serverDelay = parseRetryAfter(getHeader(error, "retry-after"));

  // Exponential backoff: 1s, 2s, 4s, 8s … + up to 50% jitter
  const baseDelay = Math.pow(2, attempt) * 1000;
  const jitteredDelay = baseDelay + Math.random() * baseDelay * 0.5;

  // Use whichever is longer — never undercut the server's cooldown request
  return Math.max(serverDelay, jitteredDelay);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run an async operation with retries.
 * Retries only on retryable errors; throws immediately on non-retryable ones.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  label: string,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      if (attempt < maxRetries && isRetryableError(error)) {
        const delay = calculateDelay(attempt, error);
        const status = (error as { status?: number }).status;
        logger.warn(
          `${label} error (attempt ${attempt + 1}/${maxRetries}), retrying in ${Math.round(delay)}ms`,
          { status, error: String(error) },
        );
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }

  // Unreachable — the loop either returns or throws — but TS needs this
  throw new Error(`${label}: exhausted retries`);
}
