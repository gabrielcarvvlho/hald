import { logger } from "./logger.js";

/** Safe JSON parse with typed fallback — prevents crashes on corrupted DB data. */
export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw);
  } catch {
    logger.warn("safeJsonParse: corrupted JSON, using fallback", {
      preview: raw.slice(0, 100),
      fallbackType: Array.isArray(fallback) ? "[]" : "{}",
    });
    return fallback;
  }
}
