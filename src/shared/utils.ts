/** Safe JSON parse with typed fallback — prevents crashes on corrupted DB data. */
export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
