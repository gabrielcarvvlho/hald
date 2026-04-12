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
import type { LocalSearchResult } from "../query/local-search.js";
import { globalSearch, classifyQuery } from "../query/global-search.js";
import type { GlobalSearchResult } from "../query/global-search.js";
import type { QueryEmbedder } from "../query/similarity.js";
import { EntityType } from "../shared/types.js";

type GetStore = () => Store;
type GetQueryEmbedder = () => Promise<QueryEmbedder>;

export function registerTools(server: McpServer, getStore: GetStore, getQueryEmbedder: GetQueryEmbedder): void {
  // ================================================================
  // hald_query
  // ================================================================

  server.registerTool(
    "hald_query",
    {
      description:
        "Search the Hald knowledge graph to answer questions about the repository's history, architecture, team, and codebase. " +
        "Returns entities, relationships, and evidence for you to synthesize.\n\n" +
        "For specific lookups, prefer: hald_find_expert (who knows X?), hald_trace_decision (why/when was X decided?), " +
        "hald_show_coupling (what co-changes with X?), hald_find_silos (bus factor risks). " +
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
        const queryEmbedder = await getQueryEmbedder();
        const searchType = search_type === "auto" ? classifyQuery(question) : search_type;

        if (searchType === "global") {
          const result = await globalSearch(store, { query: question, maxCommunities: 10, queryEmbedder });
          return {
            content: [
              {
                type: "text" as const,
                text: formatGlobalResult(result),
              },
            ],
          };
        }

        const result = await localSearch(store, {
          query: question,
          maxEntities: 15,
          maxRelations: 50,
          maxTextUnits: 20,
          queryEmbedder,
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
          ? "\n\nThe index may not exist yet. Run hald_index first."
          : "";
        return {
          content: [{ type: "text" as const, text: `Query failed: ${msg}${hint}` }],
          isError: true,
        };
      }
    },
  );

  // ================================================================
  // hald_find_expert
  // ================================================================

  server.registerTool(
    "hald_find_expert",
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

        const topScore = results[0]?.score ?? 1;
        const lines = results.map((r, i) => {
          const modules = r.modules.map((m) => {
            const entity = store.getEntity(m);
            return entity?.name ?? m;
          });
          const pct = topScore > 0 ? Math.round((r.score / topScore) * 100) : 0;
          const bar = makeBar(pct);
          const lastActive = r.lastActive.split("T")[0] ?? r.lastActive;
          return [
            `${i + 1}. **${r.person.name}** ${bar} ${pct}%`,
            `   Commits: ${r.commitCount} | Last active: ${lastActive}`,
            `   Modules: ${modules.join(", ")}`,
          ].join("\n");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `## Experts for "${module}"\n\n${lines.join("\n\n")}`,
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
  // hald_trace_decision
  // ================================================================

  server.registerTool(
    "hald_trace_decision",
    {
      description:
        "Trace the history of a technical or architectural decision through the knowledge graph. " +
        "Returns DECISION entities, the people who made them, related modules, and supporting commit evidence.\n\n" +
        "Use when asked: 'why did we switch to X?', 'when was Y adopted?', 'what motivated the migration to Z?'. " +
        "For general history questions, use hald_query instead.",
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
        const queryEmbedder = await getQueryEmbedder();

        // Search for DECISION entities matching the topic
        const result = await localSearch(store, {
          query: topic,
          maxEntities: 15,
          maxRelations: 50,
          maxTextUnits: 20,
          entityTypes: [EntityType.DECISION],
          queryEmbedder,
        });

        // Also do a broader search if no decisions found
        if (result.entities.length === 0) {
          const broader = await localSearch(store, {
            query: topic,
            maxEntities: 15,
            maxRelations: 50,
            maxTextUnits: 20,
            queryEmbedder,
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
  // hald_show_coupling
  // ================================================================

  server.registerTool(
    "hald_show_coupling",
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

        const maxCoChanges = Math.max(...results.map((r) => r.coChangeCount), 1);
        const lines = results.map((r) => {
          const pct = (r.coChangeRatio * 100).toFixed(0);
          const bar = makeBar(Math.round((r.coChangeCount / maxCoChanges) * 100));
          const authors = r.sharedAuthors.length > 0 ? r.sharedAuthors.join(", ") : "none";
          return `- **${r.module.name}** ${bar} ${r.coChangeCount} co-changes (${pct}% probability)\n  Shared authors: ${authors}`;
        });

        const highCoupling = results.filter((r) => r.coChangeRatio > 0.5);
        const insight =
          highCoupling.length > 0
            ? `\n> **Note:** ${highCoupling.length} module(s) change >50% of the time when "${module}" changes — consider if they should be colocated or decoupled.\n`
            : "";

        return {
          content: [
            {
              type: "text" as const,
              text: `## Coupling Analysis: "${module}"\n\n${lines.join("\n\n")}${insight}`,
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
  // hald_get_path
  // ================================================================

  server.registerTool(
    "hald_get_path",
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
          const arrow = rel.sourceId === stepFrom.id ? "→" : "←";
          const desc = rel.description ? ` — ${rel.description}` : "";
          return `${i + 1}. **${stepFrom.name}** ${arrow} *[${rel.type}]* ${arrow} **${stepTo.name}**${desc}`;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `## Path: ${fromEntity.name} → ${toEntity.name}\n\n**${result.length} hop(s)** connecting these entities:\n\n${steps.join("\n")}`,
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
  // hald_get_entity
  // ================================================================

  server.registerTool(
    "hald_get_entity",
    {
      description:
        "Look up a specific entity by ID, exact name, or fuzzy search. Returns full details including type, " +
        "description, aliases, activity timeline, and all relationships.\n\n" +
        "Accepts entity IDs ('person:alice-chen'), names ('Alice Chen'), or search terms. " +
        "For ranked expert lists, use hald_find_expert instead.",
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

        const firstSeen = entity.firstSeen.split("T")[0] ?? entity.firstSeen;
        const lastSeen = entity.lastSeen.split("T")[0] ?? entity.lastSeen;
        const lines = [
          `## ${entity.name}`,
          "",
          `| Field | Value |`,
          `|-------|-------|`,
          `| Type | ${entity.type} |`,
          `| ID | \`${entity.id}\` |`,
          `| Active | ${firstSeen} → ${lastSeen} |`,
          `| Frequency | ${entity.frequency} changes |`,
        ];

        if (entity.aliases.length > 0) {
          lines.push(`| Aliases | ${entity.aliases.join(", ")} |`);
        }

        if (entity.description) {
          lines.push("", `> ${entity.description}`);
        }

        // Show relations grouped by type
        const rels = store.getRelationsForEntity(entity.id);
        if (rels.length > 0) {
          lines.push("", `### Relationships (${rels.length})\n`);

          const relsByType = new Map<string, typeof rels>();
          for (const rel of rels) {
            const list = relsByType.get(rel.type) ?? [];
            list.push(rel);
            relsByType.set(rel.type, list);
          }

          for (const [type, typeRels] of relsByType) {
            lines.push(`**${type}**`);
            for (const rel of typeRels) {
              const otherId = rel.sourceId === entity.id ? rel.targetId : rel.sourceId;
              const other = store.getEntity(otherId);
              const otherName = other?.name ?? otherId;
              const arrow = rel.sourceId === entity.id ? "→" : "←";
              lines.push(`- ${arrow} ${otherName} (weight: ${rel.weight})`);
            }
            lines.push("");
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
  // hald_find_silos
  // ================================================================

  server.registerTool(
    "hald_find_silos",
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
        const sections: string[] = [
          "## Knowledge Risk Report\n",
          `**${orphaned.length}** orphaned module(s) | **${silos.length}** knowledge silo(s) | **${results.length}** total at-risk\n`,
        ];

        if (orphaned.length > 0) {
          sections.push(`### CRITICAL — Orphaned Modules (no active maintainer)\n`);
          for (const r of orphaned) {
            const lastDate = r.lastActivity.split("T")[0] ?? r.lastActivity;
            sections.push(
              `- **${r.module.name}** — ${r.module.frequency} changes, last activity: ${lastDate}\n  No active maintainer. Consider assigning an owner or archiving.`,
            );
          }
        }

        if (silos.length > 0) {
          sections.push(`\n### WARNING — Knowledge Silos (bus factor = 1)\n`);
          for (const r of silos) {
            const lastDate = r.lastActivity.split("T")[0] ?? r.lastActivity;
            sections.push(
              `- **${r.module.name}** — sole expert: **${r.soloExpert?.name ?? "unknown"}**, ${r.module.frequency} changes, last activity: ${lastDate}`,
            );
          }
          sections.push(
            `\n> **Recommendation:** Consider pairing or rotating contributors on silo modules to increase bus factor.`,
          );
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
  // hald_index
  // ================================================================

  server.registerTool(
    "hald_index",
    {
      description:
        "Build or refresh the Hald knowledge graph for this repository. Reads git history, extracts entities " +
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
                    "1. Call **hald_extract_next** to get the next chunk.",
                    "2. Pass the system prompt and user prompt through your LLM to extract entities.",
                    "3. Call **hald_submit_extraction** with the resulting XML.",
                    "4. Repeat until hald_extract_next says all chunks are done.",
                    "5. Call **hald_finalize_index** to build the knowledge graph.",
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
  // hald_stats
  // ================================================================

  server.registerTool(
    "hald_stats",
    {
      description:
        "Get statistics about the current Hald index: entity/relation/community counts, last indexed commit, " +
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
                text: "The index exists but has never been populated. Run hald_index first.",
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: [
                "## Hald Index Statistics",
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
              text: "No index found. Run hald_index to build the knowledge graph.",
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ================================================================
  // hald_reset
  // ================================================================

  server.registerTool(
    "hald_reset",
    {
      description:
        "Delete the Hald index database and start fresh. " +
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

        // Close any active agent session before deleting the DB
        clearSession();

        unlinkSync(dbPath);
        // Clean up WAL/SHM journal files (better-sqlite3 uses WAL mode)
        for (const suffix of ["-wal", "-shm"]) {
          try {
            unlinkSync(dbPath + suffix);
          } catch {
            // journal file may not exist
          }
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Index deleted: ${dbPath}. Run hald_index to rebuild.`,
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
  // hald_extract_next (agent-mediated)
  // ================================================================

  server.registerTool(
    "hald_extract_next",
    {
      description:
        "Get the next text unit chunk for agent-mediated entity extraction. " +
        "Returns the system prompt and user prompt to pass through your LLM. " +
        "Call this after hald_index starts an agent-mediated session.",
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
                text: "No active agent-mediated session. Run hald_index first (with no LLM API key set).",
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
                  "Call **hald_finalize_index** to build the knowledge graph.",
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
                "Pass the following system prompt and user prompt to your LLM, then submit the XML output via **hald_submit_extraction**.",
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
  // hald_submit_extraction (agent-mediated)
  // ================================================================

  server.registerTool(
    "hald_submit_extraction",
    {
      description:
        "Submit the XML entity extraction result for the current chunk. " +
        "Call this after processing the prompt from hald_extract_next.",
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
                "Call **hald_extract_next** for the next chunk.",
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
  // hald_finalize_index (agent-mediated)
  // ================================================================

  server.registerTool(
    "hald_finalize_index",
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
                "Run hald_index again with an API key to generate summaries.",
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

/** Render a visual progress bar for rankings. */
function makeBar(pct: number): string {
  const filled = Math.round(pct / 10);
  return "\u2588".repeat(filled) + "\u2591".repeat(10 - filled);
}

function formatLocalResult(result: LocalSearchResult): string {
  const sections: string[] = [];

  // Group entities by type for clearer reading
  if (result.entities.length > 0) {
    const matchInfo =
      result.totalEntityMatches > result.entities.length
        ? ` (${result.entities.length} of ${result.totalEntityMatches} matches)`
        : "";
    sections.push(`## Entities${matchInfo}\n`);

    const grouped = new Map<string, typeof result.entities>();
    for (const e of result.entities) {
      const list = grouped.get(e.type) ?? [];
      list.push(e);
      grouped.set(e.type, list);
    }

    for (const [type, entities] of grouped) {
      sections.push(`**${type}**`);
      for (const e of entities) {
        const relevance = e.isSeed ? "direct match" : `${e.hopDistance}-hop`;
        const lastSeen = e.lastSeen.split("T")[0] ?? e.lastSeen;
        sections.push(`- **${e.name}** (${relevance}, score ${e.score.toFixed(2)}) — ${e.description} [last active: ${lastSeen}]`);
      }
      sections.push("");
    }
  }

  if (result.relations.length > 0) {
    sections.push("## Relationships\n");
    // Group relations by type for clarity
    const relByType = new Map<string, typeof result.relations>();
    for (const r of result.relations) {
      const list = relByType.get(r.type) ?? [];
      list.push(r);
      relByType.set(r.type, list);
    }

    for (const [type, rels] of relByType) {
      sections.push(`**${type}**`);
      for (const r of rels) {
        const desc = r.description ? ` — ${r.description}` : "";
        sections.push(`- ${r.sourceName} → ${r.targetName} (weight: ${r.weight})${desc}`);
      }
      sections.push("");
    }
  }

  if (result.communities.length > 0) {
    sections.push("## Community Context\n");
    for (const c of result.communities) {
      sections.push(`### ${c.title}\n${c.summary}\n`);
    }
  }

  if (result.textUnits.length > 0) {
    sections.push("## Supporting Evidence (commit history)\n");
    for (const tu of result.textUnits) {
      const start = tu.dateRange.start.split("T")[0] ?? tu.dateRange.start;
      const end = tu.dateRange.end.split("T")[0] ?? tu.dateRange.end;
      sections.push(`### ${start} to ${end}\n\`\`\`\n${tu.content}\n\`\`\`\n`);
    }
  }

  if (sections.length === 0) {
    return "No relevant information found in the knowledge graph for this query.";
  }

  return sections.join("\n");
}

function formatGlobalResult(result: GlobalSearchResult): string {
  if (result.communities.length === 0) {
    return "No relevant community summaries found for this query.";
  }

  const sections: string[] = [];

  if (result.topEntities.length > 0) {
    sections.push("## Key Entities\n");
    for (const e of result.topEntities) {
      sections.push(`- **${e.name}** [${e.type}] — ${e.description}`);
    }
    sections.push("");
  }

  sections.push(`## Community Summaries (${result.communities.length} of ${result.totalCommunities})\n`);
  for (const c of result.communities) {
    sections.push(`### ${c.title}\n\n${c.summary}\n`);
  }
  return sections.join("\n");
}
