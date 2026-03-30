import { simpleGit } from "simple-git";
import type { CommitData, FileChange } from "../shared/types.js";
import { logger } from "../shared/logger.js";

export interface GitReaderOptions {
  repoPath: string;
  branch?: string;
  sinceCommit?: string;
  sinceDate?: string;
  maxCommits?: number;
}

/**
 * Stream commits from a git repository, oldest first.
 * Uses two efficient git log calls for all commits (not N+1).
 */
export async function* readCommits(
  options: GitReaderOptions,
): AsyncIterable<CommitData> {
  const git = simpleGit(options.repoPath);
  const args = buildLogArgs(options);

  const end = logger.time("git-reader: read commits");

  // Call 1: commit metadata + file statuses (M/A/D/R + paths)
  const rawNameStatus = await git.raw([
    "log",
    "--reverse",
    `--format=__COMMIT__%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s`,
    "--name-status",
    "-M",
    ...args,
  ]);

  // Call 2: commit hashes + numstat (additions/deletions per file)
  const rawNumstat = await git.raw([
    "log",
    "--reverse",
    `--format=__COMMIT__%H`,
    "--numstat",
    ...args,
  ]);

  const commits = parseNameStatusLog(rawNameStatus);
  const numstatMap = parseNumstatLog(rawNumstat);

  for (const commit of commits) {
    const stats = numstatMap.get(commit.hash);
    if (stats) {
      commit.filesChanged = mergeFileInfo(commit.filesChanged, stats);
    }
    yield commit;
  }

  end();
  logger.info("git-reader: done", { commits: commits.length });
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
  if (options.maxCommits) args.push(`-n`, `${options.maxCommits}`);
  if (options.sinceDate) args.push(`--since=${options.sinceDate}`);
  if (options.sinceCommit) args.push(`${options.sinceCommit}..HEAD`);
  if (options.branch && options.branch !== "HEAD") args.push(options.branch);
  return args;
}

// ================================================================
// Parsers
// ================================================================

const UNIT_SEP = "\x1f";

function parseNameStatusLog(raw: string): CommitData[] {
  if (!raw.trim()) return [];

  const commits: CommitData[] = [];
  const blocks = raw.split("__COMMIT__").filter(Boolean);

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
  const blocks = raw.split("__COMMIT__").filter(Boolean);

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
        path: parts[2]!,
      });
    }

    result.set(hash, files);
  }

  return result;
}

function mergeFileInfo(
  statusFiles: FileChange[],
  numstatFiles: NumstatEntry[],
): FileChange[] {
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
