import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../store/queries.js";
import { EntityType } from "../shared/types.js";

type GetStore = () => Store;

export function registerResources(server: McpServer, getStore: GetStore): void {
  // ================================================================
  // hald://stats
  // ================================================================

  server.registerResource(
    "stats",
    "hald://stats",
    {
      description: "Current index stats: entity count, relation count, last indexed commit, etc.",
      mimeType: "application/json",
    },
    async () => {
      try {
        const store = getStore();
        const stats = store.getStats();
        const lastCommit = store.getMeta("last_indexed_commit");
        const lastIndexed = store.getMeta("last_indexed_at");

        return {
          contents: [
            {
              uri: "hald://stats",
              mimeType: "application/json",
              text: JSON.stringify(
                {
                  ...stats,
                  lastIndexedCommit: lastCommit,
                  lastIndexedAt: lastIndexed,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri: "hald://stats",
              mimeType: "application/json",
              text: JSON.stringify({ error: "No index found" }),
            },
          ],
        };
      }
    },
  );

  // ================================================================
  // hald://graph/summary
  // ================================================================

  server.registerResource(
    "graph-summary",
    "hald://graph/summary",
    {
      description: "High-level summary of the knowledge graph structure and top communities.",
      mimeType: "text/plain",
    },
    async () => {
      try {
        const store = getStore();
        const stats = store.getStats();

        // Get top-level communities
        const levels = [2, 1, 0];
        let communities: ReturnType<typeof store.getCommunitiesByLevel> = [];
        for (const level of levels) {
          communities = store.getCommunitiesByLevel(level);
          if (communities.length > 0) break;
        }

        const lines = [
          "# Hald Knowledge Graph Summary",
          "",
          `Entities: ${stats.entities} | Relations: ${stats.relations} | Communities: ${stats.communities}`,
          "",
        ];

        if (communities.length > 0) {
          lines.push("## Top Communities", "");
          for (const c of communities.slice(0, 10)) {
            lines.push(`### ${c.title}`, c.summary, "");
          }
        }

        return {
          contents: [
            {
              uri: "hald://graph/summary",
              mimeType: "text/plain",
              text: lines.join("\n"),
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri: "hald://graph/summary",
              mimeType: "text/plain",
              text: "No index found. Run hald_index first.",
            },
          ],
        };
      }
    },
  );

  // ================================================================
  // hald://graph/entity-types
  // ================================================================

  server.registerResource(
    "entity-types",
    "hald://graph/entity-types",
    {
      description:
        "Breakdown of entities in the knowledge graph by type (PERSON, MODULE, TECHNOLOGY, DECISION, PATTERN) with counts and examples.",
      mimeType: "application/json",
    },
    async () => {
      try {
        const store = getStore();
        const breakdown: Record<string, { count: number; examples: string[] }> = {};

        for (const type of Object.values(EntityType)) {
          const entities = store.getEntitiesByType(type);
          breakdown[type] = {
            count: entities.length,
            examples: entities
              .sort((a, b) => b.frequency - a.frequency)
              .slice(0, 5)
              .map((e) => e.name),
          };
        }

        return {
          contents: [
            {
              uri: "hald://graph/entity-types",
              mimeType: "application/json",
              text: JSON.stringify(breakdown, null, 2),
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri: "hald://graph/entity-types",
              mimeType: "application/json",
              text: JSON.stringify({ error: "No index found" }),
            },
          ],
        };
      }
    },
  );
}
