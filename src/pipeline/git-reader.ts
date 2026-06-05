import { simpleGit } from "simple-git";
import type { CommitData, FileChange } from "../shared/types.js";
import { logger } from "../shared/logger.js";

// Extensions whose diffs are noise — skip to save tokens
const DIFF_SKIP_EXTENSIONS = new Set([
  ".lock", ".sum", ".min.js", ".min.css", ".map", ".snap",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".eot",
  ".pb", ".pyc", ".pyo", ".class", ".o", ".so", ".dylib",
]);

// Max lines per file diff at reader level to prevent memory pressure
const MAX_DIFF_LINES_PER_FILE = 500;

const DIFF_SKIP_PATHS = [
  "node_modules/", "vendor/", "dist/", "build/", ".next/",
  "__pycache__/", ".git/",
];

function shouldSkipDiff(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (DIFF_SKIP_EXTENSIONS.has(ext)) return true;
  for (const prefix of DIFF_SKIP_PATHS) {
    if (filePath.startsWith(prefix) || filePath.includes(`/${prefix}`)) return true;
  }
  return false;
}

export interface GitReaderOptions {
  repoPath: string;
  branch?: string;
  sinceCommit?: string;
  sinceDate?: string;
  /**
   * Cap on commits to read in a single pass. Selects the OLDEST N commits
   * chronologically (not the newest), so repeated incremental scans backfill
   * history in order: each scan advances the checkpoint to the newest commit it
   * processed, and the next scan resumes from there until the repo is fully
   * indexed. Combine with `sinceCommit` for resumable, batched indexing.
   */
  maxCommits?: number;
}

/**
 * Stream commits from a git repository, oldest first.
 * Uses two efficient git log calls for all commits (not N+1).
 */
export async function* readCommits(options: GitReaderOptions): AsyncIterable<CommitData> {
  const git = simpleGit(options.repoPath);
  const args = buildLogArgs(options);

  // Guard the no-commits case (a freshly `git init`'d repo). `git log` exits
  // fatal — "your current branch ... does not have any commits yet" — which
  // would otherwise bubble up as a scary "Indexing failed" crash. Detect it
  // up front and stream zero commits so callers hit the friendly empty path.
  if (!(await hasCommits(git))) {
    logger.info("git-reader: repository has no commits");
    return;
  }

  const end = logger.time("git-reader: read commits");

  // Call 1: commit metadata + file statuses (M/A/D/R + paths)
  const rawNameStatus = await git.raw([
    "log",
    "--reverse",
    `--format=${RECORD_SEP}%H${UNIT_SEP}%an${UNIT_SEP}%ae${UNIT_SEP}%aI${UNIT_SEP}%P${UNIT_SEP}%s`,
    "--name-status",
    "-M",
    ...args,
  ]);

  // Call 2: commit hashes + numstat (additions/deletions per file)
  const rawNumstat = await git.raw([
    "log",
    "--reverse",
    `--format=${RECORD_SEP}%H`,
    "--numstat",
    ...args,
  ]);

  // Call 3: diffs (patch) for non-merge commits
  const rawPatch = await git.raw([
    "log",
    "--reverse",
    `--format=${RECORD_SEP}%H`,
    "-p",
    "--no-merges",
    "--diff-filter=AMRT",
    ...args,
  ]);

  const parsed = parseNameStatusLog(rawNameStatus);
  // --max-commits keeps the OLDEST N commits chronologically (the stream is
  // already oldest-first via --reverse). This makes incremental scans backfill
  // correctly: the checkpoint advances to the newest commit we actually
  // processed, so the next scan picks up where this one stopped rather than
  // skipping the older tail forever (which `git log -n N` — newest N — caused).
  const commits =
    options.maxCommits && options.maxCommits > 0
      ? parsed.slice(0, options.maxCommits)
      : parsed;
  const numstatMap = parseNumstatLog(rawNumstat);
  const patchMap = parsePatchLog(rawPatch);

  for (const commit of commits) {
    const stats = numstatMap.get(commit.hash);
    if (stats) {
      commit.filesChanged = mergeFileInfo(commit.filesChanged, stats);
    }
    const patches = patchMap.get(commit.hash);
    if (patches) {
      commit.filesChanged = mergeDiffs(commit.filesChanged, patches);
    }
    yield commit;
  }

  end();
  logger.info("git-reader: done", { commits: commits.length });
}

/**
 * Returns true if the repository has at least one commit reachable from HEAD.
 * A freshly-init'd repo (no commits) returns false rather than throwing.
 */
async function hasCommits(git: ReturnType<typeof simpleGit>): Promise<boolean> {
  try {
    await git.raw(["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** Get the current HEAD commit hash. */
export async function getHead(repoPath: string): Promise<string> {
  const git = simpleGit(repoPath);
  return (await git.revparse(["HEAD"])).trim();
}

/** Get all file paths at HEAD. */
export async function getFileTree(repoPath: string): Promise<string[]> {
  const git = simpleGit(repoPath);
  const output = await git.raw(["ls-tree", "-r", "--name-only", "HEAD"]);
  return output
    .trim()
    .split("\n")
    .filter((l: string) => l.length > 0);
}

// ================================================================
// Argument builder
// ================================================================

function buildLogArgs(options: GitReaderOptions): string[] {
  const args: string[] = [];
  // NB: maxCommits is intentionally NOT translated to `git log -n N` here.
  // `-n N` with --reverse still selects the NEWEST N commits, then reverses
  // them — the opposite of what we want. We fetch the full range and slice the
  // oldest N after parsing (see readCommits), so incremental scans backfill the
  // remaining commits on subsequent runs.
  if (options.sinceDate) args.push(`--since=${options.sinceDate}`);
  if (options.sinceCommit) args.push(`${options.sinceCommit}..HEAD`);
  if (options.branch && options.branch !== "HEAD") args.push(options.branch);
  return args;
}

// ================================================================
// Parsers
// ================================================================

// Record separator (RS, 0x1E) prefixes every commit block; field separator
// (US, 0x1F) splits header fields. Both are control chars git can emit via
// %x1e/%x1f — they can never appear in a commit message, author, or path, so
// the parse is collision-proof (a message literally containing "__COMMIT__"
// no longer corrupts block boundaries).
const RECORD_SEP = "%x1e";
const UNIT_SEP = "\x1f";
const RECORD_SEP_CHAR = "\x1e";

function parseNameStatusLog(raw: string): CommitData[] {
  if (!raw.trim()) return [];

  const commits: CommitData[] = [];
  const blocks = raw.split(RECORD_SEP_CHAR).filter(Boolean);

  for (const block of blocks) {
    const lines = block.split("\n");
    const header = lines[0]!;
    const parts = header.split(UNIT_SEP);

    if (parts.length < 6) continue;

    const [hash, authorName, authorEmail, date, parents, message] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];

    const filesChanged: FileChange[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      const fc = parseNameStatusLine(line);
      if (fc) filesChanged.push(fc);
    }

    commits.push({
      hash,
      authorName,
      authorEmail: authorEmail.toLowerCase(),
      date,
      message,
      filesChanged,
      parentHashes: parents.trim() ? parents.trim().split(" ") : [],
    });
  }

  return commits;
}

function parseNameStatusLine(line: string): FileChange | null {
  const parts = line.split("\t");
  if (parts.length < 2) return null;

  const statusCode = parts[0]!;

  if (statusCode.startsWith("R") || statusCode.startsWith("C")) {
    return {
      path: parts[2] ?? parts[1]!,
      oldPath: parts[1]!,
      status: "renamed",
      additions: 0,
      deletions: 0,
    };
  }

  const statusMap: Record<string, FileChange["status"]> = {
    A: "added",
    M: "modified",
    D: "deleted",
    T: "modified",
  };

  return {
    path: parts[1]!,
    status: statusMap[statusCode] ?? "modified",
    additions: 0,
    deletions: 0,
  };
}

interface NumstatEntry {
  path: string;
  additions: number;
  deletions: number;
}

function parseNumstatLog(raw: string): Map<string, NumstatEntry[]> {
  if (!raw.trim()) return new Map();

  const result = new Map<string, NumstatEntry[]>();
  const blocks = raw.split(RECORD_SEP_CHAR).filter(Boolean);

  for (const block of blocks) {
    const lines = block.split("\n");
    const hash = lines[0]!.trim();
    if (!hash) continue;

    const files: NumstatEntry[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;

      const parts = line.split("\t");
      if (parts.length < 3) continue;

      files.push({
        additions: parts[0] === "-" ? 0 : parseInt(parts[0]!, 10),
        deletions: parts[1] === "-" ? 0 : parseInt(parts[1]!, 10),
        path: resolveNumstatPath(parts[2]!),
      });
    }

    result.set(hash, files);
  }

  return result;
}

/** Resolve numstat rename notation: `{old => new}/file.ts` → `new/file.ts` */
function resolveNumstatPath(rawPath: string): string {
  // Handle {old => new}/rest notation
  if (rawPath.includes("{") && rawPath.includes("=>")) {
    return rawPath.replace(/\{[^}]*\s*=>\s*([^}]*)\}/, "$1");
  }
  // Handle simple "old => new" notation
  if (rawPath.includes(" => ")) {
    return rawPath.split(" => ")[1]!.trim();
  }
  return rawPath;
}

function mergeFileInfo(statusFiles: FileChange[], numstatFiles: NumstatEntry[]): FileChange[] {
  const statsMap = new Map<string, NumstatEntry>();
  for (const f of numstatFiles) {
    statsMap.set(f.path, f);
  }

  return statusFiles.map((f) => {
    const stats = statsMap.get(f.path) ?? statsMap.get(f.oldPath ?? "");
    return {
      ...f,
      additions: stats?.additions ?? f.additions,
      deletions: stats?.deletions ?? f.deletions,
    };
  });
}

// ================================================================
// Patch (diff) parsing
// ================================================================

interface PatchEntry {
  path: string;
  diff: string;
}

function parsePatchLog(raw: string): Map<string, PatchEntry[]> {
  if (!raw.trim()) return new Map();

  const result = new Map<string, PatchEntry[]>();
  const blocks = raw.split(RECORD_SEP_CHAR).filter(Boolean);

  for (const block of blocks) {
    const lines = block.split("\n");
    const hash = lines[0]!.trim();
    if (!hash) continue;

    const patches: PatchEntry[] = [];
    let currentPath: string | null = null;
    let currentLines: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;

      if (line.startsWith("diff --git ")) {
        // Flush previous patch
        if (currentPath !== null) {
          patches.push({ path: currentPath, diff: currentLines.join("\n") });
        }

        // Extract path from "diff --git a/... b/<path>"
        const match = line.match(/^diff --git a\/.+ b\/(.+)$/);
        const filePath = match?.[1] ?? "";

        if (shouldSkipDiff(filePath)) {
          currentPath = null;
          currentLines = [];
        } else {
          currentPath = filePath;
          currentLines = [line];
        }
        continue;
      }

      if (currentPath !== null && currentLines.length < MAX_DIFF_LINES_PER_FILE) {
        currentLines.push(line);
      }
    }

    // Flush last patch in block
    if (currentPath !== null) {
      patches.push({ path: currentPath, diff: currentLines.join("\n") });
    }

    if (patches.length > 0) {
      result.set(hash, patches);
    }
  }

  return result;
}

function mergeDiffs(files: FileChange[], patches: PatchEntry[]): FileChange[] {
  const patchMap = new Map<string, PatchEntry>();
  for (const p of patches) {
    patchMap.set(p.path, p);
  }

  return files.map((f) => {
    const patch = patchMap.get(f.path) ?? patchMap.get(f.oldPath ?? "");
    if (patch) {
      return { ...f, diff: patch.diff };
    }
    return f;
  });
}
