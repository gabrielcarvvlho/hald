// CLI entry point — implemented in Phase 3 (Step 18)
// For now, just verify the foundation loads correctly.

import { loadConfig } from "./shared/config.js";
import { logger } from "./shared/logger.js";

const config = loadConfig();
logger.info("Git Oracle CLI", { version: "0.1.0", repoPath: config.repoPath });
logger.info("CLI commands (index, query, stats) will be implemented in Phase 3.");
