import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../store/queries.js";
import { loadConfig } from "../shared/config.js";
import { indexRepository } from "../pipeline/orchestrator.js";
import { findExperts, getCoupling } from "../query/graph-ops.js";
import { localSearch } from "../query/local-search.js";
import { globalSearch, classifyQuery } from "../query/global-search.js";
import { EntityType } from "../shared/types.js";

type GetStore = () => Store;

export function registerTools(server: McpServer, getStore: GetStore): void {
  // ================================================================
  // git_oracle_query
  // ================================================================

  server.registerTool(
    "git_oracle_query",
    {
      description:
        "Answer a free-form question about the repository's history, architecture, decisions, and team knowledge using the Git Oracle knowledge graph. Returns structured context that you should synthesize into a helpful narrative.",
      inputSchema: z.object({
        question: z.string().describe("The question to answer"),
        search_type: z
          .enum(["local", "global", "auto"])
          .default("auto")
          .describe(
            "local = entity-centric (who/what questions), global = thematic (why/how questions), auto = let the system decide",
          ),
      }),
    },
    async ({ question, search_type }) => {
      const store = getStore();
      const searchType =
        search_type === "auto" ? classifyQuery(question) : search_type;

      if (searchType === "global") {
        const result = globalSearch(store, { query: question, maxCommunities: 5 });
        return {
          content: [
            {
              type: "text" as const,
              text: formatGlobalResult(result.communities),
            },
          ],
        };
      }

      const result = localSearch(store, {
        query: question,
        maxEntities: 10,
        maxRelations: 20,
        maxTextUnits: 5,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: formatLocalResult(result),
          },
        ],
      };
    },
  );

  // ================================================================
  // git_oracle_find_expert
  // ================================================================

  server.registerTool(
    "git_oracle_find_expert",
    {
      description:
        "Find the people with the most knowledge about a specific module, file, or area of the codebase. Returns ranked experts with their activity details.",
      inputSchema: z.object({
        module: z
          .string()
          .describe("File path, directory, or module name to find experts for"),
        top_n: z
          .number()
          .default(5)
          .describe("Number of experts to return"),
      }),
    },
    async ({ module, top_n }) => {
      const store = getStore();
      const results = findExperts(store, module, top_n);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No experts found for "${module}". The module may not exist in the index, or no one has authored/modified it.`,
            },
          ],
        };
      }

      const lines = results.map((r, i) => {
        const modules = r.modules.map((m) => {
          const entity = store.getEntity(m);
          return entity?.name ?? m;
        });
        return `${i + 1}. **${r.person.name}** — score: ${r.score}, commits: ${r.commitCount}, last active: ${r.lastActive}, modules: ${modules.join(", ")}`;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `## Experts for "${module}"\n\n${lines.join("\n")}`,
          },
        ],
      };
    },
  );

  // ================================================================
  // git_oracle_trace_decision
  // ================================================================

  server.registerTool(
    "git_oracle_trace_decision",
    {
      description:
        "Trace the history of an architectural or technical decision. Returns the timeline of commits, people involved, and context.",
      inputSchema: z.object({
        topic: z
          .string()
          .describe(
            "The decision or migration to trace (e.g., 'REST to gRPC migration', 'TypeScript adoption')",
          ),
      }),
    },
    async ({ topic }) => {
      const store = getStore();

      // Search for DECISION entities matching the topic
      const result = localSearch(store, {
        query: topic,
        maxEntities: 10,
        maxRelations: 20,
        maxTextUnits: 10,
        entityTypes: [EntityType.DECISION],
      });

      // Also do a broader search if no decisions found
      if (result.entities.length === 0) {
        const broader = localSearch(store, {
          query: topic,
          maxEntities: 10,
          maxRelations: 20,
          maxTextUnits: 10,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: formatLocalResult(broader),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: formatLocalResult(result),
          },
        ],
      };
    },
  );

  // ================================================================
  // git_oracle_show_coupling
  // ================================================================

  server.registerTool(
    "git_oracle_show_coupling",
    {
      description:
        "Show which modules/files tend to change together, indicating architectural coupling.",
      inputSchema: z.object({
        module: z
          .string()
          .describe("File path or directory to analyze coupling for"),
        min_co_changes: z
          .number()
          .default(3)
          .describe("Minimum number of co-changes to include"),
      }),
    },
    async ({ module, min_co_changes }) => {
      const store = getStore();
      const results = getCoupling(store, module, min_co_changes);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No coupling data found for "${module}" with minimum ${min_co_changes} co-changes.`,
            },
          ],
        };
      }

      const lines = results.map(
        (r) =>
          `- **${r.module.name}**: ${r.coChangeCount} co-changes (ratio: ${(r.coChangeRatio * 100).toFixed(1)}%), shared authors: ${r.sharedAuthors.join(", ") || "none"}`,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `## Coupling for "${module}"\n\n${lines.join("\n")}`,
          },
        ],
      };
    },
  );

  // ================================================================
  // git_oracle_index
  // ================================================================

  server.registerTool(
    "git_oracle_index",
    {
      description:
        "Index or re-index the current repository. Run this before querying if the index doesn't exist or is stale.",
      inputSchema: z.object({
        full: z
          .boolean()
          .default(false)
          .describe("Force full re-index (vs incremental)"),
        max_commits: z
          .number()
          .optional()
          .describe("Limit number of commits to index"),
        since_date: z
          .string()
          .optional()
          .describe("Only index commits after this date (ISO format)"),
      }),
    },
    async ({ full, max_commits, since_date }) => {
      try {
        const config = loadConfig({
          maxCommits: max_commits,
          sinceDate: since_date,
        });

        const result = await indexRepository(config, { full });

        return {
          content: [
            {
              type: "text" as const,
              text: `Indexing complete!\n\n- Commits processed: ${result.commitsProcessed}\n- Entities: ${result.entitiesFound}\n- Relations: ${result.relationsFound}\n- Communities: ${result.communitiesFound}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Indexing failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ================================================================
  // git_oracle_stats
  // ================================================================

  server.registerTool(
    "git_oracle_stats",
    {
      description: "Get statistics about the current Git Oracle index.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const store = getStore();
        const stats = store.getStats();
        const lastCommit = store.getMeta("last_indexed_commit");
        const lastIndexed = store.getMeta("last_indexed_at");

        return {
          content: [
            {
              type: "text" as const,
              text: [
                "## Git Oracle Index Statistics",
                "",
                `- Entities: ${stats.entities}`,
                `- Relations: ${stats.relations}`,
                `- Text Units: ${stats.textUnits}`,
                `- Communities: ${stats.communities}`,
                `- Commits: ${stats.commits}`,
                "",
                `- Last indexed commit: ${lastCommit ?? "none"}`,
                `- Last indexed at: ${lastIndexed ?? "never"}`,
              ].join("\n"),
            },
          ],
        };
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: "No index found. Run the git_oracle_index tool first.",
            },
          ],
        };
      }
    },
  );
}

// ================================================================
// Formatters
// ================================================================

function formatLocalResult(result: ReturnType<typeof localSearch>): string {
  const sections: string[] = [];

  if (result.entities.length > 0) {
    sections.push("## Entities\n");
    for (const e of result.entities) {
      sections.push(
        `- **[${e.type}] ${e.name}**: ${e.description} (frequency: ${e.frequency}, last seen: ${e.lastSeen})`,
      );
    }
  }

  if (result.relations.length > 0) {
    const nameById = new Map(result.entities.map((e) => [e.id, e.name]));
    sections.push("\n## Relationships\n");
    for (const r of result.relations.slice(0, 15)) {
      const source = nameById.get(r.sourceId) ?? r.sourceId;
      const target = nameById.get(r.targetId) ?? r.targetId;
      sections.push(
        `- ${source} —[${r.type}]→ ${target}: ${r.description} (weight: ${r.weight})`,
      );
    }
  }

  if (result.textUnits.length > 0) {
    sections.push("\n## Supporting Evidence\n");
    for (const tu of result.textUnits) {
      sections.push(
        `### Commits ${tu.dateRange.start} to ${tu.dateRange.end}\n${tu.content}\n`,
      );
    }
  }

  if (result.communities.length > 0) {
    sections.push("\n## Community Context\n");
    for (const c of result.communities) {
      sections.push(`### ${c.title}\n${c.summary}\n`);
    }
  }

  if (sections.length === 0) {
    return "No relevant information found in the knowledge graph for this query.";
  }

  return sections.join("\n");
}

function formatGlobalResult(
  communities: ReturnType<typeof globalSearch>["communities"],
): string {
  if (communities.length === 0) {
    return "No relevant community summaries found for this query.";
  }

  const sections: string[] = [];
  for (const c of communities) {
    sections.push(`## ${c.title}\n\n${c.summary}\n`);
  }
  return sections.join("\n");
}
