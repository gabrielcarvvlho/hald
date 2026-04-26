/**
 * Preview the PrettyPresenter UI without running a real scan.
 *
 * Animates through all 8 pipeline stages with realistic timing and counts,
 * then prints the summary card. Costs nothing, no LLM calls. Use this to
 * visually check the listr2 UI on your terminal after touching the
 * presenter.
 *
 * Run:
 *   npx tsx scripts/preview-pretty-scan.ts
 */

import { PrettyPresenter } from "../src/shared/presenter.js";
import type { IndexResult } from "../src/pipeline/orchestrator.js";

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function main() {
  const presenter = new PrettyPresenter();
  const startMs = Date.now();

  // 1. Reading commits
  presenter.stageStart("reading");
  await sleep(600);
  presenter.stageEnd("reading", "1,247 commits");

  // 2. Chunking (fast)
  presenter.stageStart("chunking");
  await sleep(180);
  presenter.stageEnd("chunking", "312 text units");

  // 3. Extracting — async with progress updates (this is the long one)
  presenter.stageStart("extracting");
  const total = 312;
  for (let done = 0; done <= total; done += 8) {
    presenter.stageUpdate("extracting", Math.min(done, total), total);
    await sleep(45);
  }
  presenter.stageEnd("extracting", "847 entities, 2,134 relations");

  // 4. Resolving
  presenter.stageStart("resolving");
  await sleep(220);
  presenter.stageEnd("resolving", "612 unique entities");

  // 5. Build graph
  presenter.stageStart("building");
  await sleep(140);
  presenter.stageEnd("building");

  // 6. Clustering
  presenter.stageStart("clustering");
  await sleep(380);
  presenter.stageEnd("clustering", "21 communities");

  // 7. Summarizing — also async with progress
  presenter.stageStart("summarizing");
  const summTotal = 14;
  for (let done = 0; done <= summTotal; done++) {
    presenter.stageUpdate("summarizing", done, summTotal);
    await sleep(120);
  }
  presenter.stageEnd("summarizing", "14 new, 7 reused");

  // 8. Embeddings
  presenter.stageStart("embedding");
  await sleep(450);
  presenter.stageEnd("embedding", "612 entities, 21 communities");

  // Summary card
  const result: IndexResult = {
    commitsProcessed: 1247,
    entitiesFound: 612,
    relationsFound: 2134,
    communitiesFound: 21,
    communitiesSummarized: 14,
    tokenUsage: {
      inputTokens: 384720,
      outputTokens: 89340,
      requests: 312,
      failures: 2,
    },
    actualCostUsd: 0.7423,
  };
  await presenter.final(result, Date.now() - startMs);
}

main().catch((err) => {
  console.error("Preview failed:", err);
  process.exit(1);
});
