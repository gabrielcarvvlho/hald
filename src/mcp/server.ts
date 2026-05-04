import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../shared/config.js";
import { openDatabase } from "../store/db.js";
import { Store } from "../store/queries.js";
import { logger } from "../shared/logger.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { createEmbeddingClient } from "../llm/embeddings.js";
import { detectProvider } from "../llm/client.js";
import { QueryEmbedder } from "../query/similarity.js";
import { VERSION } from "../shared/version.js";

/**
 * Create and configure the MCP server with all tools and resources.
 * The Store is lazily initialized on first tool use (the DB might not exist yet).
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "hald",
    version: VERSION,
  });

  // Lazy store — initialized on first use
  let store: Store | null = null;
  function getStore(): Store {
    if (!store) {
      const config = loadConfig();
      const db = openDatabase(config.storagePath);
      store = new Store(db);
    }
    return store;
  }

  // Lazy QueryEmbedder — initialized on first use
  let queryEmbedder: QueryEmbedder | null = null;
  let queryEmbedderInitialized = false;
  async function getQueryEmbedder(): Promise<QueryEmbedder> {
    if (!queryEmbedderInitialized) {
      queryEmbedderInitialized = true;
      try {
        const detected = detectProvider();
        const provider = detected?.provider ?? "auto";
        const client = await createEmbeddingClient({
          provider,
          maxRetries: 2,
        });
        queryEmbedder = new QueryEmbedder(client);
      } catch {
        queryEmbedder = new QueryEmbedder(null);
      }
    }
    return queryEmbedder ?? new QueryEmbedder(null);
  }

  registerTools(server, getStore, getQueryEmbedder);
  registerResources(server, getStore);

  return server;
}

/** Start the MCP server on stdio transport. */
export async function startServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server started on stdio");
}
