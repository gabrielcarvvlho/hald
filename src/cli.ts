import "dotenv/config";
import { join } from "node:path";
import chalk from "chalk";
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
import { selectPresenter, PrettyPresenter, type Presenter } from "./shared/presenter.js";
import { logger, LogLevel } from "./shared/logger.js";
import { VERSION } from "./shared/version.js";

const program = new Command();

program
  .name("hald")
  .description("Your codebase, held. GraphRAG-powered codebase intelligence for git repositories.")
  .version(VERSION);

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
    let presenter: Presenter | undefined;
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

      // Step 5: Run pipeline with a presenter that adapts to the environment.
      // - TTY: PrettyPresenter (listr2/ora). Logger is silenced to WARN so info
      //   spew doesn't clobber the live UI.
      // - Non-TTY / CI / HALD_JSON_LOGS=1: JsonPresenter. Logger keeps emitting
      //   JSON to stderr exactly as before; final summary prints to stdout
      //   matching the legacy console.log format byte-for-byte.
      presenter = selectPresenter();
      const isPretty = presenter instanceof PrettyPresenter;
      if (isPretty) logger.setLevel(LogLevel.WARN);

      const startMs = Date.now();
      const result = await indexRepository(config, {
        full: opts.full,
        presenter,
      });

      await presenter.final(result, Date.now() - startMs);
    } catch (err) {
      if (presenter) presenter.abort(err);
      // Restore logger so the error message itself is never swallowed.
      logger.setLevel(LogLevel.INFO);
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

    // Silence INFO-level migration logs in TTY mode so they don't print above
    // the card. Errors and warnings still surface. Same gating as scan.
    const isPretty =
      process.stderr.isTTY === true && !process.env.HALD_JSON_LOGS && !process.env.CI;
    if (isPretty) logger.setLevel(LogLevel.WARN);

    const store = new Store(db);
    const stats = store.getStats();
    const lastCommit = store.getMeta("last_indexed_commit");
    const lastIndexed = store.getMeta("last_indexed_at");
    store.close();

    const rows: [string, string][] = [
      ["Entities", stats.entities.toLocaleString()],
      ["Relations", stats.relations.toLocaleString()],
      ["Text units", stats.textUnits.toLocaleString()],
      ["Communities", stats.communities.toLocaleString()],
      ["Commits", stats.commits.toLocaleString()],
    ];
    const sepIdx = rows.length;
    if (lastCommit) {
      const shortHash = lastCommit.slice(0, 7);
      const rel = lastIndexed ? formatRelative(lastIndexed) : "";
      rows.push(["Last commit", rel ? `${shortHash} ${chalk.dim("· " + rel)}` : shortHash]);
    } else {
      rows.push(["Last commit", chalk.dim("(none)")]);
    }
    rows.push(["Storage", chalk.dim(config.storagePath)]);

    const labelWidth = Math.max(...rows.map(([k]) => k.length));
    process.stdout.write(
      `\n${chalk.bold("◉ Hald")} ${chalk.dim("— index for " + config.repoPath)}\n\n`,
    );
    rows.forEach(([k, v], i) => {
      if (i === sepIdx) process.stdout.write("\n");
      process.stdout.write(`  ${chalk.dim(k.padEnd(labelWidth))}  ${v}\n`);
    });
    process.stdout.write("\n");
  });

/**
 * Format an ISO timestamp as a short, human-friendly relative string.
 * Falls back to a localized date for anything older than 30 days, and
 * returns the original input if parsing fails.
 */
function formatRelative(isoTimestamp: string): string {
  const then = new Date(isoTimestamp).getTime();
  if (Number.isNaN(then)) return isoTimestamp;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "in the future";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(isoTimestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ================================================================
// graph
// ================================================================

program
  .command("graph")
  .description("Open an interactive graph visualization in the browser")
  .option("--port <number>", "HTTP server port", (v) => parseInt(v, 10), 3742)
  .option("--no-open", "Don't auto-open the browser")
  .option("--mock", "Use built-in mock data (skip the index — useful for visual iteration)")
  .action(async (opts) => {
    try {
      const { startVizServer } = await import("./viz/server.js");

      if (opts.mock) {
        const { createMockProvider } = await import("./viz/mock.js");
        await startVizServer({
          provider: createMockProvider(),
          port: opts.port,
          open: opts.open,
        });
        return;
      }

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

      const { createStoreProvider } = await import("./viz/provider.js");
      await startVizServer({
        provider: createStoreProvider(store),
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
