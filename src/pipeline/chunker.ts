import { createHash } from "node:crypto";
import type { CommitData, FileChange, TextUnit } from "../shared/types.js";

// ================================================================
// Constants
// ================================================================

/** Max diff lines per file before truncation. */
const MAX_DIFF_LINES = 50;

/** Max files listed per commit before truncation. */
const MAX_FILES_SHOWN = 20;

/** Max commit message characters before truncation. */
const MAX_MESSAGE_CHARS = 500;

/** How many positions around the target split point to search for natural boundaries. */
const BOUNDARY_SEARCH_RADIUS = 2;

export interface ChunkerOptions {
  commitsPerChunk: number;
  maxChunkTokens: number;
}

/**
 * Group commits into TextUnits suitable for LLM extraction.
 * Commits must be sorted chronologically (oldest first).
 *
 * Uses smart boundary detection: instead of fixed N-commit windows,
 * searches near the target boundary for author or date changes to keep
 * related commit clusters together.
 *
 * Merge commits are deflated: their file lists and diffs are stripped
 * because those changes are already present in the merged branch commits.
 * The merge message is preserved (valuable for DECISION extraction).
 */
export function chunk(
  commits: CommitData[],
  options: ChunkerOptions,
): TextUnit[] {
  const { commitsPerChunk, maxChunkTokens } = options;
  const textUnits: TextUnit[] = [];

  const prepared = deflateMergeCommits(commits);
  const boundaries = findChunkBoundaries(prepared, commitsPerChunk);

  let start = 0;
  for (const end of boundaries) {
    splitAndCreate(prepared.slice(start, end), maxChunkTokens, textUnits);
    start = end;
  }
  if (start < prepared.length) {
    splitAndCreate(prepared.slice(start), maxChunkTokens, textUnits);
  }

  return textUnits;
}

/**
 * Find optimal chunk boundaries using author/date affinity.
 *
 * For each target split point (every `targetSize` commits), searches
 * ±BOUNDARY_SEARCH_RADIUS positions for natural boundaries where
 * author or date changes. Scores:
 *   2 = both author AND date change (strongest boundary)
 *   1 = author OR date change
 *   0 = no change (falls back to target position)
 *
 * For small target sizes (< 4), uses fixed windows since the
 * variance would be disproportionate.
 */
function findChunkBoundaries(
  commits: CommitData[],
  targetSize: number,
): number[] {
  if (commits.length === 0) return [];

  const boundaries: number[] = [];
  let pos = 0;

  // Only search for smart boundaries when target is large enough
  const radius = targetSize >= 4 ? BOUNDARY_SEARCH_RADIUS : 0;

  while (pos < commits.length) {
    const target = pos + targetSize;

    // Remaining commits form the last chunk
    if (target >= commits.length) break;

    if (radius === 0) {
      boundaries.push(target);
      pos = target;
      continue;
    }

    // Search for the best natural boundary near the target
    const searchStart = Math.max(pos + 1, target - radius);
    const searchEnd = Math.min(commits.length, target + radius + 1);

    let bestSplit = target;
    let bestScore = 0;
    let bestDistance = 0;

    for (let i = searchStart; i < searchEnd; i++) {
      const prev = commits[i - 1]!;
      const curr = commits[i]!;

      let score = 0;
      if (prev.authorName !== curr.authorName) score += 1;
      if (extractDate(prev.date) !== extractDate(curr.date)) score += 1;

      const distance = Math.abs(i - target);

      // Prefer higher score; break ties by closer to target
      if (
        score > bestScore ||
        (score === bestScore && score > 0 && distance < bestDistance)
      ) {
        bestSplit = i;
        bestScore = score;
        bestDistance = distance;
      }
    }

    boundaries.push(bestSplit);
    pos = bestSplit;
  }

  return boundaries;
}

/**
 * Strip file changes from merge commits to prevent duplicate extraction.
 * A merge commit replays changes already present in the merged branch,
 * so including them again wastes tokens and produces duplicate entities.
 */
function deflateMergeCommits(commits: CommitData[]): CommitData[] {
  return commits.map((c) => {
    if (c.parentHashes.length > 1) {
      return { ...c, filesChanged: [] };
    }
    return c;
  });
}

/**
 * Recursively split a commit window until each chunk fits within maxChunkTokens.
 */
function splitAndCreate(
  commits: CommitData[],
  maxTokens: number,
  out: TextUnit[],
): void {
  const content = renderTextUnit(commits);
  const tokens = estimateTokens(content);

  if (tokens <= maxTokens || commits.length <= 1) {
    out.push(createTextUnit(commits, content));
    return;
  }

  // Split in half and recurse
  const mid = Math.ceil(commits.length / 2);
  splitAndCreate(commits.slice(0, mid), maxTokens, out);
  splitAndCreate(commits.slice(mid), maxTokens, out);
}

// ================================================================
// Rendering
// ================================================================

function renderTextUnit(commits: CommitData[]): string {
  const lines: string[] = [];

  for (const commit of commits) {
    // Compact header: hash, date, author name (no email — LLM ignores it)
    lines.push(
      `[${commit.hash.slice(0, 7)}] ${extractDate(commit.date)} ${commit.authorName}`,
    );

    // Truncate long commit messages (e.g. release notes, squash merge bodies)
    lines.push(truncateMessage(commit.message));

    if (commit.filesChanged.length > 0) {
      renderFileChanges(commit.filesChanged, lines);
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Render file changes with split strategy:
 * - Files WITHOUT diffs get a compact summary line
 * - Files WITH diffs get the diff (truncated) — no redundant summary since
 *   the diff header already contains the path
 */
function renderFileChanges(files: FileChange[], lines: string[]): void {
  const filesWithDiff: FileChange[] = [];
  const filesWithoutDiff: FileChange[] = [];

  for (const f of files) {
    if (f.diff?.trim() && !isBinaryDiff(f.diff)) {
      filesWithDiff.push(f);
    } else {
      filesWithoutDiff.push(f);
    }
  }

  // Shared budget: total files shown per commit is capped at MAX_FILES_SHOWN
  let budget = MAX_FILES_SHOWN;

  // Compact summary for files without diffs (one per line)
  const totalWithout = filesWithoutDiff.length;
  const shownWithout = filesWithoutDiff.slice(0, budget);
  for (const f of shownWithout) {
    lines.push(`  ${f.path} +${f.additions}-${f.deletions}`);
  }
  budget -= shownWithout.length;
  if (totalWithout > shownWithout.length) {
    lines.push(`  ... and ${totalWithout - shownWithout.length} more files`);
  }

  // Diffs with truncation (uses remaining budget)
  const totalWithDiff = filesWithDiff.length;
  const shownWithDiff = filesWithDiff.slice(0, Math.max(budget, 1));
  for (const f of shownWithDiff) {
    lines.push(`--- ${f.path} +${f.additions}-${f.deletions}`);
    lines.push(truncateDiff(f.diff!));
  }
  if (totalWithDiff > shownWithDiff.length) {
    lines.push(`... and ${totalWithDiff - shownWithDiff.length} more diffs`);
  }
}

function truncateMessage(message: string): string {
  if (message.length <= MAX_MESSAGE_CHARS) return message;
  return message.slice(0, MAX_MESSAGE_CHARS) + "...";
}

function truncateDiff(diff: string): string {
  const diffLines = diff.split("\n");
  if (diffLines.length <= MAX_DIFF_LINES) return diff;
  return (
    diffLines.slice(0, MAX_DIFF_LINES).join("\n") +
    `\n... ${diffLines.length - MAX_DIFF_LINES} more lines`
  );
}

/** Detect binary diff markers produced by git. */
function isBinaryDiff(diff: string): boolean {
  return diff.startsWith("Binary files") || diff.startsWith("GIT binary patch");
}

function extractDate(isoDate: string): string {
  return isoDate.split("T")[0] ?? isoDate;
}

// ================================================================
// TextUnit creation
// ================================================================

function createTextUnit(commits: CommitData[], content: string): TextUnit {
  const hashes = commits.map((c) => c.hash);
  const id = `tu:${createHash("sha256").update(hashes.join(",")).digest("hex").slice(0, 12)}`;

  return {
    id,
    content,
    commitHashes: hashes,
    dateRange: {
      start: commits[0]!.date,
      end: commits[commits.length - 1]!.date,
    },
    entityIds: [],
    relationIds: [],
  };
}

/** Rough token estimation: ~4 chars per token for English text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
