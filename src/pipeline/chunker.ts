import { createHash } from "node:crypto";
import type { CommitData, TextUnit } from "../shared/types.js";

export interface ChunkerOptions {
  commitsPerChunk: number;
  maxChunkTokens: number;
}

/**
 * Group commits into TextUnits suitable for LLM extraction.
 * Commits must be sorted chronologically (oldest first).
 */
export function chunk(
  commits: CommitData[],
  options: ChunkerOptions,
): TextUnit[] {
  const { commitsPerChunk, maxChunkTokens } = options;
  const textUnits: TextUnit[] = [];

  for (let i = 0; i < commits.length; i += commitsPerChunk) {
    const window = commits.slice(i, i + commitsPerChunk);
    splitAndCreate(window, maxChunkTokens, textUnits);
  }

  return textUnits;
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
  const dateStart = extractDate(commits[0]!.date);
  const dateEnd = extractDate(commits[commits.length - 1]!.date);

  const lines: string[] = [
    `=== Commits from ${dateStart} to ${dateEnd} ===`,
    "",
  ];

  for (const commit of commits) {
    lines.push(
      `[${commit.hash.slice(0, 7)}] ${extractDate(commit.date)} ${commit.authorName} <${commit.authorEmail}>`,
    );
    lines.push(commit.message);

    if (commit.filesChanged.length > 0) {
      const filesSummary = commit.filesChanged
        .map((f) => `${f.path} (+${f.additions} -${f.deletions})`)
        .join(", ");
      lines.push(`Files: ${filesSummary}`);

      for (const file of commit.filesChanged) {
        if (file.diff) {
          lines.push(`Diff (${file.path}):`);
          lines.push(file.diff);
        }
      }
    }

    lines.push("");
  }

  return lines.join("\n").trim();
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
