import { Command } from "commander";
import { loadConfig } from "./shared/config.js";
import { openDatabase } from "./store/db.js";
import { Store } from "./store/queries.js";
import { indexRepository } from "./pipeline/orchestrator.js";
import { localSearch } from "./query/local-search.js";
import { globalSearch, classifyQuery } from "./query/global-search.js";

const program = new Command();

program
  .name("git-oracle")
  .description("GraphRAG-powered knowledge graph for git repositories")
  .version("0.1.0");

// ================================================================
// index
// ================================================================

program
  .command("index")
  .description("Index the current repository's git history")
  .option("--full", "Force full re-index (ignore previous index)")
  .option("--max-commits <n>", "Limit number of commits to process", parseInt)
  .option("--since <date>", "Only index commits after this ISO date")
  .option(
    "--provider <name>",
    "LLM provider (anthropic|openai|google|auto)",
    "auto",
  )
  .action(async (opts) => {
    try {
      const config = loadConfig({
        maxCommits: opts.maxCommits,
        sinceDate: opts.since,
        provider: opts.provider,
      });

      console.log(
        `Indexing ${config.repoPath}${opts.full ? " (full re-index)" : ""}...`,
      );

      const result = await indexRepository(config, {
        full: opts.full,
        onProgress: (stage, done, total) => {
          if (total > 0) {
            process.stderr.write(`\r  ${stage}: ${done}/${total}`);
          }
        },
      });

      console.log("");
      console.log(`Done!`);
      console.log(`  Commits processed: ${result.commitsProcessed}`);
      console.log(`  Entities: ${result.entitiesFound}`);
      console.log(`  Relations: ${result.relationsFound}`);
      console.log(`  Communities: ${result.communitiesFound}`);
    } catch (err) {
      console.error(`\nIndexing failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ================================================================
// query
// ================================================================

program
  .command("query <question>")
  .description("Query the knowledge graph")
  .option("--type <type>", "Search type (local|global|auto)", "auto")
  .action(async (question: string, opts) => {
    try {
      const config = loadConfig();

      const db = openDatabase(config.storagePath);
      const store = new Store(db);

      // Check index exists
      const stats = store.getStats();
      if (stats.entities === 0) {
        console.error(
          "No index found. Run `git-oracle index` first.",
        );
        store.close();
        process.exit(1);
      }

      // Determine search type
      const searchType =
        opts.type === "auto" ? classifyQuery(question) : opts.type;

      console.log(`Search type: ${searchType}\n`);

      if (searchType === "global") {
        const result = globalSearch(store, {
          query: question,
          maxCommunities: 5,
        });

        if (result.communities.length === 0) {
          console.log("No relevant communities found.");
        } else {
          for (const community of result.communities) {
            console.log(`## ${community.title}`);
            console.log(community.summary);
            console.log("");
          }
        }
      } else {
        const result = localSearch(store, {
          query: question,
          maxEntities: 10,
          maxRelations: 20,
          maxTextUnits: 5,
        });

        if (result.entities.length === 0) {
          console.log("No relevant entities found.");
        } else {
          // Build name lookup for human-readable relation display
          const nameById = new Map(result.entities.map((e) => [e.id, e.name]));

          console.log("### Entities");
          for (const e of result.entities) {
            console.log(
              `  [${e.type}] ${e.name} — ${e.description} (freq: ${e.frequency})`,
            );
          }

          if (result.relations.length > 0) {
            console.log("\n### Relations");
            for (const r of result.relations.slice(0, 10)) {
              const sourceName = nameById.get(r.sourceId) ?? r.sourceId;
              const targetName = nameById.get(r.targetId) ?? r.targetId;
              console.log(
                `  ${sourceName} --[${r.type}]--> ${targetName} (weight: ${r.weight})`,
              );
            }
          }

          if (result.communities.length > 0) {
            console.log("\n### Community Context");
            for (const c of result.communities) {
              console.log(`  ${c.title}: ${c.summary.slice(0, 200)}...`);
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
      console.log("No index found. Run `git-oracle index` first.");
      return;
    }

    const store = new Store(db);
    const stats = store.getStats();
    const lastCommit = store.getMeta("last_indexed_commit");
    const lastIndexed = store.getMeta("last_indexed_at");

    console.log("Git Oracle Index Statistics");
    console.log("==========================");
    console.log(`  Entities:    ${stats.entities}`);
    console.log(`  Relations:   ${stats.relations}`);
    console.log(`  Text Units:  ${stats.textUnits}`);
    console.log(`  Communities: ${stats.communities}`);
    console.log(`  Commits:     ${stats.commits}`);
    console.log("");
    console.log(
      `  Last indexed commit: ${lastCommit ?? "none"}`,
    );
    console.log(
      `  Last indexed at:     ${lastIndexed ?? "never"}`,
    );
    console.log(
      `  Storage:             ${config.storagePath}`,
    );

    store.close();
  });

// ================================================================
// Run
// ================================================================

program.parse();
