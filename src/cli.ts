import "dotenv/config";
import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "./shared/config.js";
import { openDatabase } from "./store/db.js";
import { Store } from "./store/queries.js";
import { indexRepository } from "./pipeline/orchestrator.js";
import { localSearch } from "./query/local-search.js";
import { globalSearch, classifyQuery } from "./query/global-search.js";
import { readCommits } from "./pipeline/git-reader.js";
import { chunk } from "./pipeline/chunker.js";
import {
  estimateCost,
  estimateCommunityCount,
  formatCostEstimate,
} from "./pipeline/cost-estimator.js";
import { detectProvider } from "./llm/client.js";
import { createEmbeddingClient } from "./llm/embeddings.js";
import { QueryEmbedder } from "./query/similarity.js";

const program = new Command();

program
  .name("hald")
  .description("Your codebase, held. GraphRAG-powered codebase intelligence for git repositories.")
  .version("0.1.0");

// ================================================================
// index
// ================================================================

program
  .command("scan")
  .description("Scan the current repository's git history")
  .option("--full", "Force full re-index (ignore previous index)")
  .option("--max-commits <n>", "Limit number of commits to process", parseInt)
  .option("--since <date>", "Only index commits after this ISO date")
  .option("--provider <name>", "LLM provider (anthropic|openai|google|zhipu|auto)", "auto")
  .option("-y, --yes", "Skip cost confirmation prompt")
  .action(async (opts) => {
    try {
      const config = loadConfig({
        maxCommits: opts.maxCommits,
        sinceDate: opts.since,
        provider: opts.provider,
      });

      // Detect actual provider for cost estimation
      const detected = detectProvider();
      const providerName =
        config.provider === "auto" ? (detected?.provider ?? "unknown") : config.provider;

      console.log(
        `\n◉ Hald — Scanning ${config.repoPath}${opts.full ? " (full re-index)" : ""}\n`,
      );

      // Step 1: Read commits (fast, no LLM cost)
      const spinnerText = (text: string) => process.stderr.write(`\r  ${text}${"".padEnd(20)}`);

      spinnerText("Reading commits...");
      let sinceCommit: string | undefined;
      if (!opts.full) {
        try {
          const db = openDatabase(config.storagePath);
          const store = new Store(db);
          sinceCommit = store.getMeta("last_indexed_commit") ?? undefined;
          store.close();
        } catch {
          // No existing index, full index
        }
      }

      const commits = [];
      for await (const commit of readCommits({
        repoPath: config.repoPath,
        branch: config.branch,
        maxCommits: config.maxCommits,
        sinceDate: config.sinceDate,
        sinceCommit,
      })) {
        commits.push(commit);
      }

      if (commits.length === 0) {
        process.stderr.write("\r");
        console.log("  No new commits to index. Index is up to date.\n");
        return;
      }

      // Step 2: Chunk (fast, no LLM cost)
      const textUnits = chunk(commits, {
        commitsPerChunk: config.commitsPerChunk,
        maxChunkTokens: config.maxChunkTokens,
        maxDiffLines: config.maxDiffLines,
        maxFilesShown: config.maxFilesShown,
        maxMessageChars: config.maxMessageChars,
      });

      // Step 3: Show cost estimate
      process.stderr.write("\r");
      const estimatedEntities = Math.round(commits.length * 1.5);
      const estimatedCommunities = estimateCommunityCount(estimatedEntities);
      const cost = estimateCost(textUnits, estimatedCommunities, providerName);

      console.log(`  Commits:     ${commits.length}`);
      console.log(`  Text units:  ${textUnits.length}`);
      console.log("");
      console.log("  Estimated cost:");
      console.log(formatCostEstimate(cost));
      console.log("");

      // Step 4: Confirm (skip with --yes)
      if (!opts.yes && cost.estimatedCostUsd > 0.01) {
        const readline = await import("node:readline");
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await new Promise<string>((resolve) =>
          rl.question("  Proceed? [Y/n] ", resolve),
        );
        rl.close();
        if (answer.toLowerCase() === "n") {
          console.log("  Aborted.\n");
          return;
        }
      }

      console.log("");

      // Step 5: Run full pipeline
      const result = await indexRepository(config, {
        full: opts.full,
        onProgress: (stage, done, total) => {
          if (total > 0) {
            process.stderr.write(`\r  ${stage}: ${done}/${total}${"".padEnd(10)}`);
          } else {
            process.stderr.write(`\r  ${stage}...${"".padEnd(10)}`);
          }
        },
      });

      process.stderr.write("\r");
      console.log(`  Done!`);
      console.log(`  Commits processed:       ${result.commitsProcessed}`);
      console.log(`  Entities:                ${result.entitiesFound}`);
      console.log(`  Relations:               ${result.relationsFound}`);
      console.log(`  Communities:             ${result.communitiesFound}`);
      console.log(`  Communities summarized:  ${result.communitiesSummarized}`);
      if (result.tokenUsage.requests > 0) {
        console.log(
          `  LLM requests:            ${result.tokenUsage.requests} (${result.tokenUsage.failures} failed)`,
        );
        console.log(
          `  Tokens:                  ${result.tokenUsage.inputTokens.toLocaleString()} in / ${result.tokenUsage.outputTokens.toLocaleString()} out`,
        );
        console.log(`  Cost:                    $${result.actualCostUsd.toFixed(4)}`);
      }
      console.log("");
    } catch (err) {
      process.stderr.write("\r");
      console.error(`\nIndexing failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

// ================================================================
// query
// ================================================================

program
  .command("ask <question>")
  .description("Query the knowledge graph")
  .option("--type <type>", "Search type (local|global|auto)", "auto")
  .action(async (question: string, opts) => {
    try {
      const config = loadConfig();

      const db = openDatabase(config.storagePath);
      const store = new Store(db);

      const stats = store.getStats();
      if (stats.entities === 0) {
        console.error("No index found. Run `hald scan` first.");
        store.close();
        process.exit(1);
      }

      const searchType = opts.type === "auto" ? classifyQuery(question) : opts.type;

      // Create QueryEmbedder if an embedding-capable provider is available
      const detected = detectProvider();
      const provider = detected?.provider ?? "auto";
      const embeddingClient = await createEmbeddingClient({ provider, maxRetries: 2 });
      const queryEmbedder = new QueryEmbedder(embeddingClient);

      console.log(`Search type: ${searchType}\n`);

      if (searchType === "global") {
        const result = await globalSearch(store, {
          query: question,
          maxCommunities: 5,
          queryEmbedder,
        });

        if (result.communities.length === 0) {
          console.log("No relevant communities found.");
        } else {
          if (result.topEntities.length > 0) {
            console.log("### Key Entities");
            for (const e of result.topEntities) {
              console.log(`  [${e.type}] ${e.name} — ${e.description}`);
            }
            console.log("");
          }
          for (const community of result.communities) {
            console.log(`## ${community.title}`);
            console.log(community.summary);
            console.log("");
          }
        }
      } else {
        const result = await localSearch(store, {
          query: question,
          maxEntities: 10,
          maxRelations: 20,
          maxTextUnits: 5,
          queryEmbedder,
        });

        if (result.entities.length === 0) {
          console.log("No relevant entities found.");
        } else {
          if (result.totalEntityMatches > result.entities.length) {
            console.log(
              `### Entities (showing ${result.entities.length} of ${result.totalEntityMatches})`,
            );
          } else {
            console.log("### Entities");
          }
          for (const e of result.entities) {
            const tag = e.isSeed ? "seed" : `${e.hopDistance}-hop`;
            console.log(
              `  [${e.type}] ${e.name} — ${e.description} (${tag}, score: ${e.score.toFixed(2)})`,
            );
          }

          if (result.relations.length > 0) {
            console.log("\n### Relations");
            for (const r of result.relations) {
              console.log(
                `  ${r.sourceName} --[${r.type}]--> ${r.targetName} (weight: ${r.weight})`,
              );
            }
          }

          if (result.communities.length > 0) {
            console.log("\n### Community Context");
            for (const c of result.communities) {
              console.log(`  ${c.title}: ${c.summary}`);
            }
          }
        }
      }

      store.close();
    } catch (err) {
      console.error(`Query failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ================================================================
// stats
// ================================================================

program
  .command("stats")
  .description("Show index statistics")
  .action(async () => {
    const config = loadConfig();

    let db;
    try {
      db = openDatabase(config.storagePath);
    } catch {
      console.log("No index found. Run `hald scan` first.");
      return;
    }

    const store = new Store(db);
    const stats = store.getStats();
    const lastCommit = store.getMeta("last_indexed_commit");
    const lastIndexed = store.getMeta("last_indexed_at");

    console.log("\n◉ Hald Index Statistics");
    console.log("======================");
    console.log(`  Entities:    ${stats.entities}`);
    console.log(`  Relations:   ${stats.relations}`);
    console.log(`  Text Units:  ${stats.textUnits}`);
    console.log(`  Communities: ${stats.communities}`);
    console.log(`  Commits:     ${stats.commits}`);
    console.log("");
    console.log(`  Last indexed commit: ${lastCommit ?? "none"}`);
    console.log(`  Last indexed at:     ${lastIndexed ?? "never"}`);
    console.log(`  Storage:             ${config.storagePath}`);
    console.log("");

    store.close();
  });

// ================================================================
// graph
// ================================================================

program
  .command("graph")
  .description("Open an interactive graph visualization in the browser")
  .option("--port <number>", "HTTP server port", (v) => parseInt(v, 10), 3742)
  .option("--no-open", "Don't auto-open the browser")
  .action(async (opts) => {
    try {
      const config = loadConfig();

      let db;
      try {
        db = openDatabase(config.storagePath);
      } catch {
        console.error("No index found. Run `hald scan` first.");
        process.exit(1);
      }

      const store = new Store(db);
      const stats = store.getStats();
      if (stats.entities === 0) {
        console.error("No entities found. Run `hald scan` first.");
        store.close();
        process.exit(1);
      }

      const { startVizServer } = await import("./viz/server.js");
      await startVizServer({
        store,
        port: opts.port,
        open: opts.open,
      });
    } catch (err) {
      console.error(`\nGraph viewer failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

// ================================================================
// reset
// ================================================================

program
  .command("reset")
  .description("Delete the index database and start fresh")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (opts) => {
    const config = loadConfig();
    const { existsSync, unlinkSync } = await import("node:fs");
    const dbPath = join(config.storagePath, "oracle.db");

    if (!existsSync(dbPath)) {
      console.log("No index found. Nothing to reset.");
      return;
    }

    if (!opts.yes) {
      const readline = await import("node:readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await new Promise<string>((resolve) =>
        rl.question(`Delete ${dbPath}? [y/N] `, resolve),
      );
      rl.close();
      if (answer.toLowerCase() !== "y") {
        console.log("Aborted.");
        return;
      }
    }

    unlinkSync(dbPath);
    // Clean up WAL/SHM journal files (better-sqlite3 uses WAL mode)
    for (const suffix of ["-wal", "-shm"]) {
      try {
        unlinkSync(dbPath + suffix);
      } catch {
        // journal file may not exist — that's fine
      }
    }
    console.log(`Deleted ${dbPath}. Index has been reset.`);
  });

// ================================================================
// serve
// ================================================================

program
  .command("serve")
  .description("Start the MCP server on stdio (for use with AI agents)")
  .action(async () => {
    const { startServer } = await import("./mcp/server.js");
    await startServer();
  });

// ================================================================
// Run
// ================================================================

program.parse();
