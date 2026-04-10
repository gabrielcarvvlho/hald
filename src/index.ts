// MCP server entry point — starts the Hald MCP server on stdio.
import { startServer } from "./mcp/server.js";

startServer().catch((err) => {
  process.stderr.write(`MCP server error: ${err}\n`);
  process.exit(1);
});
