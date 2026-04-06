import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../store/queries.js";
import { loadConfig } from "../shared/config.js";
import { indexRepository } from "../pipeline/orchestrator.js";
import { NoProviderError } from "../llm/client.js";
import {
  startAgentSession,
  getSession,
  getNextChunk,
  submitExtraction,
  finalizeSession,
  clearSession,
} from "./agent-session.js";
import {
  findExperts,
  getCoupling,
  getPath,
  getEntity as lookupEntity,
  findKnowledgeSilos,
} from "../query/graph-ops.js";
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
        "Search the Git Oracle knowledge graph to answer questions about the repository's history, architecture, team, and codebase. " +
        "Returns entities, relationships, and evidence for you to synthesize.\n\n" +
        "For specific lookups, prefer: git_oracle_find_expert (who knows X?), git_oracle_trace_decision (why/when was X decided?), " +
        "git_oracle_show_coupling (what co-changes with X?), git_oracle_find_silos (bus factor risks). " +
        "Use this tool for general, thematic, or cross-cutting questions.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        question: z
          .string()
          .describe(
            "Natural language question (e.g., 'what technologies does the auth module use?', 'how has the API layer evolved?')",
          ),
        search_type: z
          .enum(["local", "global", "auto"])
          .default("auto")
          .describe(
            "Search strategy. 'local' = find specific entities and their relationships (who/what). " +
              "'global' = search community summaries for themes and patterns (why/how/overview). " +
              "'auto' = classify automatically based on question phrasing.",
          ),
      }),
    },
    async ({ question, search_type }) => {
      try {
        const store = getStore();
        const searchType = search_type === "auto" ? classifyQuery(question) : search_type;

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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const hint = /no such table|unable to open|SQLITE_/i.test(msg)
          ? "\n\nThe index may not exist yet. Run git_oracle_index first."
          : "";
        return {
          content: [{ type: "text" as const, text: `Query failed: ${msg}${hint}` }],
          isError: true,
        };
      }
    },
  );

  // ================================================================
  // git_oracle_find_expert
  // ================================================================

  server.registerTool(
    "git_oracle_find_expert",
    {
      description:
        "Find the top contributors for a module, file path, or area of the codebase. " +
        "Returns people ranked by authorship weight × recency decay.\n\n" +
        "Use when asked: 'who knows about X?', 'who should review changes to X?', 'who maintains X?'.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        module: z
          .string()
          .describe(
            "Module path, directory, or component name (e.g., 'src/payments', 'auth', 'database layer'). " +
              "Matches against entity names in the knowledge graph.",
          ),
        top_n: z.number().default(5).describe("Number of experts to return (default: 5)"),
      }),
    },
    async ({ module, top_n }) => {
      try {
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
          return `${i + 1}. **${r.person.name}** — score: ${r.score}, weight: ${r.commitCount}, last active: ${r.lastActive}, modules: ${modules.join(", ")}`;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `## Experts for "${module}"\n\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Find expert failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ================================================================
  // git_oracle_trace_decision
  // ================================================================

  server.registerTool(
    "git_oracle_trace_decision",
    {
      description:
        "Trace the history of a technical or architectural decision through the knowledge graph. " +
        "Returns DECISION entities, the people who made them, related modules, and supporting commit evidence.\n\n" +
        "Use when asked: 'why did we switch to X?', 'when was Y adopted?', 'what motivated the migration to Z?'. " +
        "For general history questions, use git_oracle_query instead.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        topic: z
          .string()
          .describe(
            "The decision or migration to trace (e.g., 'REST to gRPC migration', 'TypeScript adoption', 'monorepo restructure')",
          ),
      }),
    },
    async ({ topic }) => {
      try {
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
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Trace decision failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ================================================================
  // git_oracle_show_coupling
  // ================================================================

  server.registerTool(
    "git_oracle_show_coupling",
    {
      description:
        "Find modules that frequently change together, revealing architectural coupling. " +
        "Returns co-change counts, conditional probability ratios, and shared authors.\n\n" +
        "Use when asked: 'what else changes when I modify X?', 'what's coupled to X?', " +
        "'what's the blast radius of changing X?', or to assess refactoring impact.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        module: z
          .string()
          .describe(
            "Module path or directory (e.g., 'src/api', 'auth module'). Matches against entity names in the knowledge graph.",
          ),
        min_co_changes: z
          .number()
          .default(3)
          .describe(
            "Minimum co-change count to filter noise (default: 3). Lower values show weaker coupling.",
          ),
      }),
    },
    async ({ module, min_co_changes }) => {
      try {
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
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Show coupling failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ================================================================
  // git_oracle_get_path
  // ================================================================

  server.registerTool(
    "git_oracle_get_path",
    {
      description:
        "Find the shortest relationship path between two entities in the knowledge graph. " +
        "Reveals how people, modules, technologies, and decisions are connected through authorship, usage, and co-change relationships.\n\n" +
        "Use when asked: 'how is person X connected to module Y?', 'what's the relationship between X and Y?'.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        from: z
          .string()
          .describe("Source entity ID or name (e.g., 'person:alice-chen' or 'Alice Chen')"),
        to: z
          .string()
          .describe("Target entity ID or name (e.g., 'module:src/payments' or 'src/payments')"),
        max_depth: z.number().default(5).describe("Maximum traversal depth"),
      }),
    },
    async ({ from, to, max_depth }) => {
      try {
        const store = getStore();

        // Resolve names to IDs
        const fromEntity = lookupEntity(store, from);
        const toEntity = lookupEntity(store, to);

        if (!fromEntity) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Entity not found: "${from}"`,
              },
            ],
            isError: true,
          };
        }
        if (!toEntity) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Entity not found: "${to}"`,
              },
            ],
            isError: true,
          };
        }

        const result = getPath(store, fromEntity.id, toEntity.id, max_depth);

        if (!result) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No path found between "${fromEntity.name}" and "${toEntity.name}" within depth ${max_depth}.`,
              },
            ],
          };
        }

        if (result.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `"${fromEntity.name}" and "${toEntity.name}" are the same entity.`,
              },
            ],
          };
        }

        const steps = result.relations.map((rel, i) => {
          const stepFrom = result.path[i]!;
          const stepTo = result.path[i + 1]!;
          // Respect actual relation direction, not BFS traversal direction
          if (rel.sourceId === stepFrom.id) {
            return `  ${stepFrom.name} --[${rel.type}]--> ${stepTo.name}`;
          }
          return `  ${stepFrom.name} <--[${rel.type}]-- ${stepTo.name}`;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `## Path: ${fromEntity.name} -> ${toEntity.name} (${result.length} hops)\n\n${steps.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Get path failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ================================================================
  // git_oracle_get_entity
  // ================================================================

  server.registerTool(
    "git_oracle_get_entity",
    {
      description:
        "Look up a specific entity by ID, exact name, or fuzzy search. Returns full details including type, " +
        "description, aliases, activity timeline, and up to 15 relationships.\n\n" +
        "Accepts entity IDs ('person:alice-chen'), names ('Alice Chen'), or search terms. " +
        "For ranked expert lists, use git_oracle_find_expert instead.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "Entity ID (e.g., 'person:alice-chen'), name (e.g., 'Alice Chen'), or search term (e.g., 'payments')",
          ),
      }),
    },
    async ({ query }) => {
      try {
        const store = getStore();
        const entity = lookupEntity(store, query);

        if (!entity) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No entity found matching "${query}".`,
              },
            ],
          };
        }

        const lines = [
          `## ${entity.name}`,
          "",
          `- **Type:** ${entity.type}`,
          `- **ID:** ${entity.id}`,
          `- **Description:** ${entity.description}`,
          `- **First seen:** ${entity.firstSeen}`,
          `- **Last seen:** ${entity.lastSeen}`,
          `- **Frequency:** ${entity.frequency}`,
        ];

        if (entity.aliases.length > 0) {
          lines.push(`- **Aliases:** ${entity.aliases.join(", ")}`);
        }

        // Show relations
        const rels = store.getRelationsForEntity(entity.id);
        if (rels.length > 0) {
          lines.push("", "### Relationships", "");
          for (const rel of rels.slice(0, 15)) {
            const otherId = rel.sourceId === entity.id ? rel.targetId : rel.sourceId;
            const other = store.getEntity(otherId);
            const otherName = other?.name ?? otherId;
            const direction =
              rel.sourceId === entity.id
                ? `${entity.name} --[${rel.type}]--> ${otherName}`
                : `${otherName} --[${rel.type}]--> ${entity.name}`;
            lines.push(`- ${direction} (weight: ${rel.weight})`);
          }
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Get entity failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ================================================================
  // git_oracle_find_silos
  // ================================================================

  server.registerTool(
    "git_oracle_find_silos",
    {
      description:
        "Identify knowledge risk areas: modules with bus factor ≤ 1 (single active maintainer) and orphaned modules " +
        "(no active maintainer). Returns a risk report sorted by severity.\n\n" +
        "Use when asked: 'what's our bus factor?', 'which modules lack coverage?', 'where are the knowledge silos?', " +
        "or during team planning to identify onboarding priorities.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        min_frequency: z
          .number()
          .default(3)
          .describe(
            "Minimum change frequency to consider a module — filters trivial/config files (default: 3)",
          ),
        inactive_days: z
          .number()
          .default(180)
          .describe(
            "Days since last contribution before an author is considered inactive (default: 180)",
          ),
      }),
    },
    async ({ min_frequency, inactive_days }) => {
      try {
        const store = getStore();
        const results = findKnowledgeSilos(store, {
          minFrequency: min_frequency,
          inactiveDays: inactive_days,
        });

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No knowledge silos or orphaned modules found. All modules have multiple active contributors.",
              },
            ],
          };
        }

        const orphaned = results.filter((r) => r.activeExpertCount === 0);
        const silos = results.filter((r) => r.activeExpertCount === 1);
        const sections: string[] = ["## Knowledge Risk Report\n"];

        if (orphaned.length > 0) {
          sections.push(`### Orphaned Modules (no active maintainer)\n`);
          for (const r of orphaned) {
            sections.push(
              `- **${r.module.name}** — frequency: ${r.module.frequency}, last activity: ${r.lastActivity}`,
            );
          }
        }

        if (silos.length > 0) {
          sections.push(`\n### Knowledge Silos (bus factor = 1)\n`);
          for (const r of silos) {
            sections.push(
              `- **${r.module.name}** — sole expert: ${r.soloExpert?.name ?? "unknown"}, frequency: ${r.module.frequency}, last activity: ${r.lastActivity}`,
            );
          }
        }

        return {
          content: [{ type: "text" as const, text: sections.join("\n") }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Find silos failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ================================================================
  // git_oracle_index
  // ================================================================

  server.registerTool(
    "git_oracle_index",
    {
      description:
        "Build or refresh the Git Oracle knowledge graph for this repository. Reads git history, extracts entities " +
        "and relationships via LLM, resolves duplicates, detects communities, and generates summaries.\n\n" +
        "Duration: ~1-2 min per 500 commits. Uses incremental indexing by default (only new commits since last run). " +
        "If no LLM API key is available (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY), falls back to " +
        "agent-mediated extraction where you perform the LLM calls yourself.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        full: z
          .boolean()
          .default(false)
          .describe(
            "Force full re-index, ignoring previous progress (default: false = incremental)",
          ),
        max_commits: z
          .number()
          .optional()
          .describe("Limit number of commits to process (e.g., 500). Useful for large repos."),
        since_date: z
          .string()
          .optional()
          .describe("Only index commits after this date (e.g., '2024-01-01')"),
      }),
    },
    async ({ full, max_commits, since_date }, extra) => {
      try {
        const config = loadConfig({
          maxCommits: max_commits,
          sinceDate: since_date,
        });

        // Wire MCP progress notifications if client provided a progress token
        const progressToken = extra._meta?.progressToken;
        const onProgress = progressToken
          ? (stage: string, done: number, total: number) => {
              extra
                .sendNotification({
                  method: "notifications/progress" as const,
                  params: { progressToken, progress: done, total, message: stage },
                })
                .catch(() => {}); // fire-and-forget — progress is best-effort
            }
          : undefined;

        const result = await indexRepository(config, { full, onProgress });

        return {
          content: [
            {
              type: "text" as const,
              text: [
                "Indexing complete!",
                "",
                `- Commits processed: ${result.commitsProcessed}`,
                `- Entities: ${result.entitiesFound}`,
                `- Relations: ${result.relationsFound}`,
                `- Communities: ${result.communitiesFound}`,
                ...(result.tokenUsage.requests > 0
                  ? [
                      `- LLM requests: ${result.tokenUsage.requests}`,
                      `- Tokens: ${result.tokenUsage.inputTokens.toLocaleString()} in / ${result.tokenUsage.outputTokens.toLocaleString()} out`,
                      `- Cost: $${result.actualCostUsd.toFixed(4)}`,
                    ]
                  : []),
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        // Fall back to agent-mediated mode when no API key is available
        if (err instanceof NoProviderError) {
          try {
            const { chunkCount, commitCount } = await startAgentSession({
              full,
              maxCommits: max_commits,
              sinceDate: since_date,
            });

            if (commitCount === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "No new commits to index.",
                  },
                ],
              };
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: [
                    "No LLM API key found — switching to agent-mediated extraction.",
                    `Found ${commitCount} commits, split into ${chunkCount} chunks.`,
                    "",
                    "You will perform entity extraction using your own LLM context.",
                    "Follow this loop:",
                    "",
                    "1. Call **git_oracle_extract_next** to get the next chunk.",
                    "2. Pass the system prompt and user prompt through your LLM to extract entities.",
                    "3. Call **git_oracle_submit_extraction** with the resulting XML.",
                    "4. Repeat until git_oracle_extract_next says all chunks are done.",
                    "5. Call **git_oracle_finalize_index** to build the knowledge graph.",
                  ].join("\n"),
                },
              ],
            };
          } catch (sessionErr) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to start agent-mediated indexing: ${sessionErr instanceof Error ? sessionErr.message : String(sessionErr)}`,
                },
              ],
              isError: true,
            };
          }
        }

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
      description:
        "Get statistics about the current Git Oracle index: entity/relation/community counts, last indexed commit, " +
        "and timestamp. Use this to check whether an index exists and is up-to-date before querying.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const store = getStore();
        const stats = store.getStats();
        const lastCommit = store.getMeta("last_indexed_commit");
        const lastIndexed = store.getMeta("last_indexed_at");

        if (!lastIndexed) {
          return {
            content: [
              {
                type: "text" as const,
                text: "The index exists but has never been populated. Run git_oracle_index first.",
              },
            ],
          };
        }

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
              text: "No index found. Run git_oracle_index to build the knowledge graph.",
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ================================================================
  // git_oracle_reset
  // ================================================================

  server.registerTool(
    "git_oracle_reset",
    {
      description:
        "Delete the Git Oracle index database and start fresh. " +
        "This is destructive and cannot be undone. " +
        "Requires confirm=true to execute.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        confirm: z.boolean().describe("Must be true to confirm deletion"),
      }),
    },
    async ({ confirm }) => {
      if (!confirm) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Reset aborted. Pass confirm=true to delete the index.",
            },
          ],
        };
      }

      try {
        const { existsSync, unlinkSync } = await import("node:fs");
        const { join } = await import("node:path");
        const config = loadConfig();
        const dbPath = join(config.storagePath, "oracle.db");

        if (!existsSync(dbPath)) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No index found. Nothing to reset.",
              },
            ],
          };
        }

        unlinkSync(dbPath);
        return {
          content: [
            {
              type: "text" as const,
              text: `Index deleted: ${dbPath}. Run git_oracle_index to rebuild.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Reset failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ================================================================
  // git_oracle_extract_next (agent-mediated)
  // ================================================================

  server.registerTool(
    "git_oracle_extract_next",
    {
      description:
        "Get the next text unit chunk for agent-mediated entity extraction. " +
        "Returns the system prompt and user prompt to pass through your LLM. " +
        "Call this after git_oracle_index starts an agent-mediated session.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const session = getSession();
        if (!session) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No active agent-mediated session. Run git_oracle_index first (with no LLM API key set).",
              },
            ],
            isError: true,
          };
        }

        const chunk = getNextChunk();

        if (chunk.done) {
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `All ${chunk.total} chunks have been extracted (${chunk.extracted} submitted).`,
                  "",
                  "Call **git_oracle_finalize_index** to build the knowledge graph.",
                ].join("\n"),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `## Chunk ${chunk.index + 1} of ${chunk.total}`,
                "",
                "Pass the following system prompt and user prompt to your LLM, then submit the XML output via **git_oracle_submit_extraction**.",
                "",
                "### System Prompt",
                "",
                chunk.systemPrompt,
                "",
                "### User Prompt",
                "",
                chunk.userPrompt,
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Extract next failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ================================================================
  // git_oracle_submit_extraction (agent-mediated)
  // ================================================================

  server.registerTool(
    "git_oracle_submit_extraction",
    {
      description:
        "Submit the XML entity extraction result for the current chunk. " +
        "Call this after processing the prompt from git_oracle_extract_next.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: z.object({
        xml: z.string().describe("The <extraction>...</extraction> XML output from the LLM"),
      }),
    },
    async ({ xml }) => {
      try {
        const session = getSession();
        if (!session) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No active agent-mediated session.",
              },
            ],
            isError: true,
          };
        }

        const result = submitExtraction(xml);

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Extraction accepted: ${result.entities} entities, ${result.relations} relations.`,
                `Progress: ${result.progress}`,
                "",
                "Call **git_oracle_extract_next** for the next chunk.",
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Submit extraction failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ================================================================
  // git_oracle_finalize_index (agent-mediated)
  // ================================================================

  server.registerTool(
    "git_oracle_finalize_index",
    {
      description:
        "Finalize the agent-mediated indexing session. Runs entity resolution, " +
        "graph building, and community detection on the submitted extractions. " +
        "Call this after all chunks have been processed.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const session = getSession();
        if (!session) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No active agent-mediated session to finalize.",
              },
            ],
            isError: true,
          };
        }

        const result = await finalizeSession();

        return {
          content: [
            {
              type: "text" as const,
              text: [
                "Agent-mediated indexing complete!",
                "",
                `- Commits processed: ${result.commitsProcessed}`,
                `- Entities: ${result.entitiesFound}`,
                `- Relations: ${result.relationsFound}`,
                `- Communities: ${result.communitiesFound}`,
                "",
                "Note: Community summaries were skipped (no API key).",
                "Run git_oracle_index again with an API key to generate summaries.",
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        clearSession();
        return {
          content: [
            {
              type: "text" as const,
              text: `Finalize failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
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
    const header =
      result.totalEntityMatches > result.entities.length
        ? `## Entities (showing ${result.entities.length} of ${result.totalEntityMatches} matches)\n`
        : "## Entities\n";
    sections.push(header);
    for (const e of result.entities) {
      const tag = e.isSeed ? "seed" : `${e.hopDistance}-hop`;
      sections.push(
        `- **[${e.type}] ${e.name}** (${tag}, score: ${e.score.toFixed(2)}): ${e.description} (last seen: ${e.lastSeen})`,
      );
    }
  }

  if (result.relations.length > 0) {
    sections.push("\n## Relationships\n");
    for (const r of result.relations.slice(0, 15)) {
      sections.push(
        `- ${r.sourceName} —[${r.type}]→ ${r.targetName}: ${r.description} (weight: ${r.weight})`,
      );
    }
  }

  if (result.textUnits.length > 0) {
    sections.push("\n## Supporting Evidence\n");
    for (const tu of result.textUnits) {
      sections.push(`### Commits ${tu.dateRange.start} to ${tu.dateRange.end}\n${tu.content}\n`);
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

function formatGlobalResult(communities: ReturnType<typeof globalSearch>["communities"]): string {
  if (communities.length === 0) {
    return "No relevant community summaries found for this query.";
  }

  const sections: string[] = [];
  for (const c of communities) {
    sections.push(`## ${c.title}\n\n${c.summary}\n`);
  }
  return sections.join("\n");
}
