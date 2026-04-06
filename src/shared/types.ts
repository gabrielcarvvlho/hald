// === Identifiers ===
export type EntityId = string;
export type RelationId = string;
export type CommunityId = string;
export type TextUnitId = string;
export type CommitHash = string;

// === Entity Types ===
export enum EntityType {
  PERSON = "PERSON",
  MODULE = "MODULE",
  TECHNOLOGY = "TECHNOLOGY",
  DECISION = "DECISION",
  PATTERN = "PATTERN",
}

export interface Entity {
  id: EntityId;
  type: EntityType;
  name: string;
  aliases: string[];
  description: string;
  firstSeen: string; // ISO date
  lastSeen: string; // ISO date
  frequency: number;
  metadata: Record<string, unknown>;
}

// === Relation Types ===
export enum RelationType {
  AUTHORED = "AUTHORED",
  MODIFIED = "MODIFIED",
  CO_CHANGED = "CO_CHANGED",
  USES = "USES",
  DEPENDS_ON = "DEPENDS_ON",
  INTRODUCED = "INTRODUCED",
  REMOVED = "REMOVED",
  DECIDED = "DECIDED",
  SUPERSEDES = "SUPERSEDES",
  EXHIBITS = "EXHIBITS",
}

export interface Relation {
  id: RelationId;
  type: RelationType;
  sourceId: EntityId;
  targetId: EntityId;
  weight: number;
  description: string;
  evidence: TextUnitId[];
  firstSeen: string;
  lastSeen: string;
}

// === Text Units ===
export interface TextUnit {
  id: TextUnitId;
  content: string;
  commitHashes: CommitHash[];
  dateRange: { start: string; end: string };
  entityIds: EntityId[];
  relationIds: RelationId[];
}

// === Communities ===
export interface Community {
  id: CommunityId;
  level: number;
  title: string;
  summary: string;
  entityIds: EntityId[];
  parentId?: CommunityId;
  childIds: CommunityId[];
}

// === Git Data ===
export interface CommitData {
  hash: CommitHash;
  authorName: string;
  authorEmail: string;
  date: string; // ISO format
  message: string;
  filesChanged: FileChange[];
  parentHashes: CommitHash[];
}

export interface FileChange {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  diff?: string;
}

// === Config ===
export interface GitOracleConfig {
  repoPath: string;
  branch: string;
  maxCommits?: number;
  sinceDate?: string;

  commitsPerChunk: number;
  maxChunkTokens: number;
  /** Max diff lines per file before truncation in chunks. Default: 50 */
  maxDiffLines: number;
  /** Max files listed per commit in chunks. Default: 20 */
  maxFilesShown: number;
  /** Max commit message chars before truncation. Default: 500 */
  maxMessageChars: number;

  provider: "anthropic" | "openai" | "google" | "auto";
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxConcurrency: number;
  maxRetries: number;

  entityResolutionThreshold: number;
  /** Module path normalization depth (number of segments to keep). Default: 2 */
  moduleDepth?: number;
  /** Min text unit size (commits) to trigger gleaning. Default: 8 */
  gleaningMinCommits: number;
  /** Entities-per-commit ratio below which gleaning fires. Default: 0.5 */
  gleaningMaxEntitiesRatio: number;
  communityResolutions: number[];
  minCommunitySize: number;
  /** Min Jaccard overlap to link a child community to a parent. Default: 0.3 */
  parentLinkThreshold: number;
  /** Jaccard overlap below which a split warning is logged. Default: 0.7 */
  splitWarningThreshold: number;
  /** Min Jaccard similarity to reuse an existing community summary. Default: 0.7 */
  summaryReuseThreshold: number;

  storagePath: string;
}
