// MCP server entry point — implemented in Phase 4 (Step 19)
export { Store } from "./store/queries.js";
export { openDatabase } from "./store/db.js";
export { loadConfig } from "./shared/config.js";
export { createClient, detectProvider } from "./llm/client.js";
export type { LLMClient, LLMResponse } from "./llm/types.js";
export * from "./shared/types.js";
