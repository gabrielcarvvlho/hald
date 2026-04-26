import chalk from "chalk";
import { Listr, type ListrTask } from "listr2";
import type { IndexResult } from "../pipeline/orchestrator.js";

// listr2's task callback signature varies by renderer generics; deriving the
// task-wrapper type straight from `ListrTask['task']` parameters keeps this
// resilient to listr2 version bumps and avoids leaking renderer types here.
type TaskCtx = Parameters<NonNullable<ListrTask<unknown>["task"]>>[1];

// ================================================================
// Stage definitions — single source of truth for pipeline stages
// ================================================================

export type StageId =
  | "reading"
  | "chunking"
  | "extracting"
  | "resolving"
  | "building"
  | "clustering"
  | "summarizing"
  | "embedding";

interface StageDef {
  id: StageId;
  label: string;
}

const STAGES: readonly StageDef[] = [
  { id: "reading", label: "Read commits from git" },
  { id: "chunking", label: "Chunk into text units" },
  { id: "extracting", label: "Extract entities & relations" },
  { id: "resolving", label: "Resolve duplicate entities" },
  { id: "building", label: "Build graph" },
  { id: "clustering", label: "Cluster communities" },
  { id: "summarizing", label: "Summarize communities" },
  { id: "embedding", label: "Generate embeddings" },
];

// ================================================================
// Presenter contract
// ================================================================

export interface Presenter {
  stageStart(id: StageId, label?: string): void;
  stageUpdate(id: StageId, done: number, total: number, note?: string): void;
  stageEnd(id: StageId, summary?: string): void;
  stageWarn(id: StageId, message: string): void;
  stageError(id: StageId, err: unknown): void;
  /** Render the final summary card. Awaits any in-flight rendering. */
  final(result: IndexResult, elapsedMs: number): Promise<void>;
  /** Abort all unresolved stages with an error so the renderer unblocks. */
  abort(err: unknown): void;
}

// ================================================================
// Deferred — internal coordination primitive
// ================================================================

class Deferred<T = void> {
  promise: Promise<T>;
  private _resolve!: (v: T) => void;
  private _reject!: (e: unknown) => void;
  settled = false;

  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this._resolve = res;
      this._reject = rej;
    });
    // Swallow unhandled-rejection warnings if no one awaits before reject() runs.
    // The CLI's catch path will surface the underlying error from indexRepository().
    this.promise.catch(() => {});
  }

  resolve(v: T): void {
    if (this.settled) return;
    this.settled = true;
    this._resolve(v);
  }

  reject(e: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this._reject(e);
  }
}

// ================================================================
// JsonPresenter — preserves current non-TTY behavior byte-for-byte
// ================================================================

/**
 * Stage events are no-ops (the existing structured logger already writes
 * JSON to stderr at every stage boundary). `final()` writes the same plain-text
 * summary lines to stdout that cli.ts used to print directly. This keeps CI
 * logs, log shippers, and `scan > out.txt` redirects identical to today.
 */
export class JsonPresenter implements Presenter {
  stageStart(): void {}
  stageUpdate(): void {}
  stageEnd(): void {}
  stageWarn(): void {}
  stageError(): void {}
  abort(): void {}

  async final(result: IndexResult, _elapsedMs: number): Promise<void> {
    const lines: string[] = [
      `  Done!`,
      `  Commits processed:       ${result.commitsProcessed}`,
      `  Entities:                ${result.entitiesFound}`,
      `  Relations:               ${result.relationsFound}`,
      `  Communities:             ${result.communitiesFound}`,
      `  Communities summarized:  ${result.communitiesSummarized}`,
    ];
    if (result.tokenUsage.requests > 0) {
      lines.push(
        `  LLM requests:            ${result.tokenUsage.requests} (${result.tokenUsage.failures} failed)`,
        `  Tokens:                  ${result.tokenUsage.inputTokens.toLocaleString()} in / ${result.tokenUsage.outputTokens.toLocaleString()} out`,
        `  Cost:                    $${result.actualCostUsd.toFixed(4)}`,
      );
    }
    process.stdout.write(lines.join("\n") + "\n\n");
  }
}

// ================================================================
// PrettyPresenter — listr2-driven UI for TTY mode
// ================================================================

export interface PrettyPresenterOptions {
  /**
   * Override listr2's renderer. Tests pass "silent" to keep output clean.
   * Production omits this and lets listr2 auto-select default/simple/silent
   * based on TTY detection.
   */
  renderer?: "default" | "simple" | "silent" | "verbose";
}

export class PrettyPresenter implements Presenter {
  private readonly deferreds: Map<StageId, Deferred>;
  private readonly summaries: Map<StageId, string> = new Map();
  private readonly failures: Map<StageId, unknown> = new Map();
  private readonly taskRefs: Map<StageId, TaskCtx> = new Map();
  private readonly listrPromise: Promise<unknown>;

  constructor(opts: PrettyPresenterOptions = {}) {
    this.deferreds = new Map(STAGES.map((s) => [s.id, new Deferred()]));

    const tasks: ListrTask<unknown>[] = STAGES.map(({ id, label }) => ({
      title: label,
      task: async (_ctx, task) => {
        this.taskRefs.set(id, task);
        await this.deferreds.get(id)!.promise;
        const summary = this.summaries.get(id);
        if (summary) {
          task.title = `${label} ${chalk.dim("— " + summary)}`;
        }
      },
    }));

    // listr2 auto-detects TTY; SimpleRenderer/SilentRenderer is the fallback.
    // We don't force `default` because we want graceful degradation if stderr
    // loses TTY between selectPresenter() and listr.run() (rare but possible).
    const listrOptions: ConstructorParameters<typeof Listr>[1] = {
      concurrent: false,
      exitOnError: true,
    };
    if (opts.renderer) {
      // Cast: listr2's type unions for renderer + fallbackRenderer don't include
      // 'silent' as a literal in the public option type, but it IS a supported
      // built-in. Tests rely on this to suppress output.
      (listrOptions as Record<string, unknown>).renderer = opts.renderer;
      (listrOptions as Record<string, unknown>).fallbackRenderer = opts.renderer;
    }
    const listr = new Listr(tasks, listrOptions);

    // Swallow listr's rejection — the actual error already surfaces via
    // indexRepository's throw, which the CLI's catch block handles.
    this.listrPromise = listr.run().catch(() => undefined);
  }

  stageStart(_id: StageId, _label?: string): void {
    // listr2 starts tasks sequentially based on `concurrent: false`. The visual
    // "started" state happens when the previous task ends. We don't need to do
    // anything here. Hook is kept for future flexibility (e.g., custom labels).
  }

  stageUpdate(id: StageId, done: number, total: number, note?: string): void {
    const ref = this.taskRefs.get(id);
    if (!ref) return;
    if (total > 0) {
      ref.output = note ? `${done}/${total} · ${note}` : `${done}/${total}`;
    } else if (note) {
      ref.output = note;
    }
  }

  stageEnd(id: StageId, summary?: string): void {
    if (summary) this.summaries.set(id, summary);
    this.deferreds.get(id)?.resolve();
  }

  stageWarn(id: StageId, message: string): void {
    const ref = this.taskRefs.get(id);
    if (ref) ref.output = chalk.yellow(`! ${message}`);
  }

  stageError(id: StageId, err: unknown): void {
    this.failures.set(id, err);
    this.deferreds.get(id)?.reject(err);
  }

  abort(err: unknown): void {
    for (const [, deferred] of this.deferreds) {
      deferred.reject(err);
    }
  }

  async final(result: IndexResult, elapsedMs: number): Promise<void> {
    await this.listrPromise;
    process.stderr.write(renderSummaryCard(result, elapsedMs) + "\n");
  }
}

// ================================================================
// Pretty summary card
// ================================================================

function renderSummaryCard(result: IndexResult, elapsedMs: number): string {
  const t = result.tokenUsage;
  const elapsedStr = formatElapsed(elapsedMs);
  const reused = result.communitiesFound - result.communitiesSummarized;

  const rows: [string, string][] = [
    ["Commits processed", result.commitsProcessed.toLocaleString()],
    ["Entities", result.entitiesFound.toLocaleString()],
    ["Relations", result.relationsFound.toLocaleString()],
    [
      "Communities",
      reused > 0
        ? `${result.communitiesFound} (${result.communitiesSummarized} new, ${reused} reused)`
        : `${result.communitiesFound}`,
    ],
  ];
  if (t.requests > 0) {
    rows.push(
      [
        "LLM requests",
        t.failures > 0 ? `${t.requests} (${chalk.red(t.failures + " failed")})` : `${t.requests}`,
      ],
      ["Tokens", `${t.inputTokens.toLocaleString()} in / ${t.outputTokens.toLocaleString()} out`],
      ["Cost", chalk.green(`$${result.actualCostUsd.toFixed(4)}`)],
    );
  }
  rows.push(["Elapsed", elapsedStr]);

  const labelWidth = Math.max(...rows.map(([k]) => k.length));
  const body = rows
    .map(([k, v]) => `  ${chalk.dim(k.padEnd(labelWidth))}  ${v}`)
    .join("\n");

  return `\n${chalk.bold.green("✓ Scan complete")}\n${body}\n`;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

// ================================================================
// Selection
// ================================================================

interface PresenterSelectorOptions {
  /** Default: process.env */
  env?: NodeJS.ProcessEnv;
  /** Default: process.stderr */
  stream?: { isTTY?: boolean };
}

/**
 * Pick the right presenter for the current environment.
 *
 * JSON path is forced when:
 *   - stderr is not a TTY (CI logs, piped output, redirected stderr)
 *   - HALD_JSON_LOGS is set (explicit override for debugging)
 *   - CI is set (GitHub Actions, GitLab CI, CircleCI, etc.)
 *
 * Pretty path is used otherwise. Within pretty mode, listr2 itself further
 * degrades to SimpleRenderer/SilentRenderer if the terminal is dumb or
 * NO_COLOR is set.
 */
export function selectPresenter(opts: PresenterSelectorOptions = {}): Presenter {
  const env = opts.env ?? process.env;
  const stream = opts.stream ?? process.stderr;
  const isTTY = stream.isTTY === true;
  const forceJson = Boolean(env.HALD_JSON_LOGS) || Boolean(env.CI);
  return isTTY && !forceJson ? new PrettyPresenter() : new JsonPresenter();
}
