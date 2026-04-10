# Hald — Architecture Document

## System Overview

Hald is a TypeScript monorepo that implements a purpose-built GraphRAG pipeline for git repositories, exposed as an MCP server and packaged as a multi-platform plugin for AI coding agents (Claude Code, Cursor, OpenCode, Codex, Gemini CLI).

```
┌─────────────────────────────────────────────────────────┐
│                    User's Coding Agent                    │
│    (Claude Code / Cursor / OpenCode / Codex / Gemini)    │
├──────────────────────┬──────────────────────────────────┤
│   Platform Shim      │        MCP Protocol               │
│  (.claude-plugin/    │                                    │
│   .cursor-plugin/    │                                    │
│   .opencode/         │                                    │
│   .codex/            │                                    │
│   gemini-extension)  │                                    │
├──────────────────────┴──────────────────────────────────┤
│                  Hald MCP Server                   │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────────┐  │
│  │  Tools   │  │  Query    │  │   Graph Store        │  │
│  │  Layer   │──│  Engine   │──│   (SQLite + FTS5)    │  │
│  └──────────┘  └───────────┘  └──────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│                  Indexing Pipeline                        │
│  ┌─────────┐ ┌───────────┐ ┌────────┐ ┌─────────────┐  │
│  │  Git    │ │  Chunker  │ │  LLM   │ │  Graph      │  │
│  │  Reader │→│  & Text   │→│Extract │→│  Builder    │  │
│  │         │ │  Units    │ │        │ │  & Cluster  │  │
│  └─────────┘ └───────────┘ └────────┘ └─────────────┘  │
└─────────────────────────────────────────────────────────┘
         │                        │
         ▼                        ▼
   Git Repository         LLM Provider (auto-detected)
   (local .git)       (Anthropic / OpenAI / Google)
```

### Two-Mode Token Strategy

**Querying = zero extra cost.** MCP tools return structured graph data from SQLite. The host agent synthesizes the narrative using its own tokens — exactly like Superpowers. No API key needed.

**Indexing = provider-agnostic LLM calls.** The pipeline auto-detects available API keys from the environment and makes direct batch calls. If no key is found, falls back to agent-mediated mode (slower, but zero-config). See LLM Client section for details.

## Repository Structure

```
hald/
├── package.json                 # Workspace root
├── tsconfig.json                # Shared TS config
│
│ # === Platform Shims (one per supported agent) ===
├── .claude-plugin/
│   ├── plugin.json              # Claude Code plugin manifest
│   └── marketplace.json         # Optional marketplace config
├── .cursor-plugin/
│   └── plugin.json              # Cursor plugin manifest
├── .codex/
│   └── INSTALL.md               # Codex install instructions (agent reads this)
├── .opencode/
│   ├── INSTALL.md               # OpenCode install instructions
│   └── plugins/
│       └── hald.js        # OpenCode JS plugin (hook registration)
├── gemini-extension.json        # Gemini CLI extension manifest
├── GEMINI.md                    # Gemini CLI context file
├── .mcp.json                    # MCP server config (Claude Code + Cursor)
│
│ # === Cross-Platform Shared ===
├── hooks/
│   └── session-start.sh         # Bootstrap hook (detects platform, injects skills)
├── skills/
│   ├── hald-query/
│   │   └── SKILL.md             # Teaches agent when/how to use query tools
│   └── hald-index/
│       └── SKILL.md             # Teaches agent how to trigger indexing
├── src/
│   ├── index.ts                 # MCP server entry point
│   ├── cli.ts                   # CLI entry point (npx hald scan)
│   ├── pipeline/
│   │   ├── git-reader.ts        # Extracts commits, diffs, blame from .git
│   │   ├── chunker.ts           # Groups commits into TextUnits
│   │   ├── extractor.ts         # LLM-based entity/relation extraction
│   │   ├── resolver.ts          # Entity resolution (fuzzy dedup)
│   │   ├── graph-builder.ts     # Builds adjacency structure
│   │   ├── clusterer.ts         # Louvain community detection
│   │   └── summarizer.ts        # LLM-based community summaries
│   ├── store/
│   │   ├── db.ts                # SQLite + better-sqlite3 setup
│   │   ├── schema.ts            # Table definitions & migrations
│   │   └── queries.ts           # Prepared statements for all operations
│   ├── query/
│   │   ├── local-search.ts      # Entity-centric search (find_expert, etc.)
│   │   ├── global-search.ts     # Community-summary search (why questions)
│   │   └── graph-ops.ts         # Coupling, shortest path, centrality
│   ├── mcp/
│   │   ├── server.ts            # MCP server setup (tools, resources)
│   │   ├── tools.ts             # Tool definitions & handlers
│   │   └── resources.ts         # Resource definitions (graph stats, etc.)
│   ├── llm/
│   │   ├── client.ts            # LLM client abstraction + auto-detection
│   │   ├── anthropic.ts         # Anthropic provider (Claude)
│   │   ├── openai.ts            # OpenAI-compatible provider (GPT, Ollama, OpenRouter)
│   │   ├── google.ts            # Google provider (Gemini)
│   │   └── types.ts             # Shared LLM types
│   └── shared/
│       ├── types.ts             # Core domain types
│       ├── config.ts            # Configuration loading
│       └── logger.ts            # Structured logging
├── tests/
│   ├── fixtures/                # Sample git repos for testing
│   ├── pipeline/
│   ├── query/
│   └── integration/
├── docs/
│   ├── ARCHITECTURE.md          # This file
│   ├── PRD.md                   # Product requirements
│   └── PROMPTS.md               # LLM prompts for extraction
└── CLAUDE.md                    # Context file for Claude Code
```

## Core Data Models

### Domain Types (`src/shared/types.ts`)

```typescript
// === Identifiers ===
type EntityId = string;      // e.g., "person:alice", "module:src/billing"
type RelationId = string;    // e.g., "rel:001"
type CommunityId = string;   // e.g., "comm:0:5" (level:index)
type TextUnitId = string;    // e.g., "tu:abc123"
type CommitHash = string;    // Full SHA

// === Entity Types ===
enum EntityType {
  PERSON = "PERSON",           // Commit author, reviewer
  MODULE = "MODULE",           // File path or directory (normalized)
  TECHNOLOGY = "TECHNOLOGY",   // Language, framework, library, tool
  DECISION = "DECISION",       // Architectural decision extracted from commits
  PATTERN = "PATTERN",         // Recurring code pattern or practice
}

interface Entity {
  id: EntityId;
  type: EntityType;
  name: string;                // Canonical name
  aliases: string[];           // Alternative names (for resolution)
  description: string;         // LLM-generated summary
  firstSeen: string;           // ISO date of first appearance
  lastSeen: string;            // ISO date of most recent appearance
  frequency: number;           // Number of text units mentioning this entity
  metadata: Record<string, unknown>; // Type-specific extra data
}

// === Relation Types ===
enum RelationType {
  AUTHORED = "AUTHORED",           // PERSON → MODULE (committed changes)
  MODIFIED = "MODIFIED",           // PERSON → MODULE (changed files)
  CO_CHANGED = "CO_CHANGED",       // MODULE → MODULE (changed in same commit)
  USES = "USES",                   // MODULE → TECHNOLOGY
  DEPENDS_ON = "DEPENDS_ON",       // MODULE → MODULE (import/require)
  INTRODUCED = "INTRODUCED",       // PERSON → TECHNOLOGY (first commit using it)
  REMOVED = "REMOVED",             // PERSON → TECHNOLOGY (last commit removing it)
  DECIDED = "DECIDED",             // PERSON → DECISION
  SUPERSEDES = "SUPERSEDES",       // DECISION → DECISION
  EXHIBITS = "EXHIBITS",           // MODULE → PATTERN
}

interface Relation {
  id: RelationId;
  type: RelationType;
  sourceId: EntityId;
  targetId: EntityId;
  weight: number;              // Strength of relationship (frequency-based)
  description: string;         // LLM-generated context
  evidence: TextUnitId[];      // Which text units support this relation
  firstSeen: string;
  lastSeen: string;
}

// === Text Units ===
interface TextUnit {
  id: TextUnitId;
  content: string;             // The text chunk sent to LLM
  commitHashes: CommitHash[];  // Source commits
  dateRange: { start: string; end: string };
  entityIds: EntityId[];       // Entities extracted from this unit
  relationIds: RelationId[];   // Relations extracted from this unit
}

// === Communities ===
interface Community {
  id: CommunityId;
  level: number;               // Hierarchy level (0 = finest, 2 = coarsest)
  title: string;               // LLM-generated title
  summary: string;             // LLM-generated narrative summary
  entityIds: EntityId[];       // Member entities
  parentId?: CommunityId;      // Parent community at coarser level
  childIds: CommunityId[];     // Child communities at finer level
}

// === Git Data ===
interface CommitData {
  hash: CommitHash;
  authorName: string;
  authorEmail: string;
  date: string;                // ISO format
  message: string;
  filesChanged: FileChange[];
  parentHashes: CommitHash[];
}

interface FileChange {
  path: string;
  oldPath?: string;            // If renamed
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  diff?: string;               // Truncated diff (first N lines)
}

// === Config ===
interface HaldConfig {
  // Git
  repoPath: string;
  branch: string;              // Default: current branch
  maxCommits?: number;         // Limit for large repos
  sinceDate?: string;          // Only index commits after this date

  // Chunking
  commitsPerChunk: number;     // Default: 10
  maxChunkTokens: number;      // Default: 2000

  // LLM (provider-agnostic)
  provider: "anthropic" | "openai" | "google" | "auto";  // Default: "auto"
  model?: string;              // Provider-specific model override (see defaults below)
  apiKey?: string;             // Explicit key; falls back to env var auto-detection
  baseUrl?: string;            // Custom endpoint (for Ollama, OpenRouter, Azure, etc.)
  maxConcurrency: number;      // Default: 5 parallel extraction calls
  maxRetries: number;          // Default: 3

  // Graph
  entityResolutionThreshold: number;  // Default: 0.85 (fuzzy match score)
  communityResolutions: number[];     // Default: [0.5, 1.0, 2.0]
  minCommunitySize: number;           // Default: 3

  // Storage
  storagePath: string;         // Default: .hald/
}
```

## SQLite Schema (`src/store/schema.ts`)

```sql
-- Core tables
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,           -- EntityType enum value
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',  -- JSON array
  description TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  frequency INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}'  -- JSON object
);

CREATE TABLE relations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,           -- RelationType enum value
  source_id TEXT NOT NULL REFERENCES entities(id),
  target_id TEXT NOT NULL REFERENCES entities(id),
  weight REAL NOT NULL DEFAULT 1.0,
  description TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '[]',  -- JSON array of TextUnitIds
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE text_units (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  commit_hashes TEXT NOT NULL DEFAULT '[]',  -- JSON array
  date_start TEXT NOT NULL,
  date_end TEXT NOT NULL,
  entity_ids TEXT NOT NULL DEFAULT '[]',     -- JSON array
  relation_ids TEXT NOT NULL DEFAULT '[]'    -- JSON array
);

CREATE TABLE communities (
  id TEXT PRIMARY KEY,
  level INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  entity_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array
  parent_id TEXT REFERENCES communities(id),
  child_ids TEXT NOT NULL DEFAULT '[]'    -- JSON array
);

CREATE TABLE commits (
  hash TEXT PRIMARY KEY,
  author_name TEXT NOT NULL,
  author_email TEXT NOT NULL,
  date TEXT NOT NULL,
  message TEXT NOT NULL,
  files_changed TEXT NOT NULL DEFAULT '[]',  -- JSON array of FileChange
  parent_hashes TEXT NOT NULL DEFAULT '[]',
  text_unit_id TEXT REFERENCES text_units(id),
  indexed_at TEXT NOT NULL                   -- When this commit was processed
);

-- Index metadata
CREATE TABLE index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Stores: last_indexed_commit, index_version, config_hash, etc.

-- Full-text search
CREATE VIRTUAL TABLE entities_fts USING fts5(
  name, aliases, description,
  content='entities',
  content_rowid='rowid'
);

CREATE VIRTUAL TABLE communities_fts USING fts5(
  title, summary,
  content='communities',
  content_rowid='rowid'
);

CREATE VIRTUAL TABLE text_units_fts USING fts5(
  content,
  content='text_units',
  content_rowid='rowid'
);

-- Performance indexes
CREATE INDEX idx_relations_source ON relations(source_id);
CREATE INDEX idx_relations_target ON relations(target_id);
CREATE INDEX idx_relations_type ON relations(type);
CREATE INDEX idx_entities_type ON entities(type);
CREATE INDEX idx_entities_name ON entities(name);
CREATE INDEX idx_communities_level ON communities(level);
CREATE INDEX idx_commits_date ON commits(date);
CREATE INDEX idx_commits_author ON commits(author_email);
```

## Pipeline Modules

### 1. Git Reader (`src/pipeline/git-reader.ts`)

Extracts raw commit data from the local `.git` directory using `simple-git`.

```typescript
interface GitReaderOptions {
  repoPath: string;
  branch?: string;
  sinceCommit?: string;   // For incremental indexing
  sinceDate?: string;
  maxCommits?: number;
}

interface GitReader {
  /** Get all commits matching the options, oldest first */
  getCommits(options: GitReaderOptions): AsyncIterable<CommitData>;

  /** Get blame info for a file at a specific commit */
  getBlame(filePath: string, commit?: string): Promise<BlameResult>;

  /** Get the current HEAD commit hash */
  getHead(): Promise<string>;

  /** Get the list of all file paths at HEAD */
  getFileTree(): Promise<string[]>;
}
```

**Key behaviors:**
- Streams commits via async iterator to handle large repos without loading all into memory.
- Diffs are truncated to first 50 lines per file to control token usage.
- Binary files are excluded from diffs (only listed as changed).
- Renames are tracked via `--follow` and stored as `oldPath → path`.
- Author names and emails are normalized (lowercase email, consistent name casing).

### 2. Chunker (`src/pipeline/chunker.ts`)

Groups commits into TextUnits suitable for LLM extraction.

```typescript
interface ChunkerOptions {
  commitsPerChunk: number;   // Target commits per chunk
  maxChunkTokens: number;    // Max tokens per chunk
}

interface Chunker {
  /** Group commits into text units */
  chunk(commits: CommitData[], options: ChunkerOptions): TextUnit[];
}
```

**Chunking strategy:**
1. Sort commits chronologically (oldest first).
2. Group into windows of `commitsPerChunk` commits.
3. For each window, render a text representation:
   ```
   === Commits from 2024-03-01 to 2024-03-05 ===

   [abc1234] 2024-03-01 Alice <alice@co.com>
   feat: migrate payments endpoint to gRPC
   Files: src/payments/handler.ts (+45 -12), src/proto/payments.proto (+89 -0)
   Diff (src/payments/handler.ts):
     - app.post('/api/payments', ...
     + const paymentService = new PaymentsGrpcClient(...

   [def5678] 2024-03-02 Bob <bob@co.com>
   refactor: extract shared auth middleware
   Files: src/middleware/auth.ts (+34 -0), src/payments/handler.ts (+2 -15), src/users/handler.ts (+2 -18)
   ```
4. If a chunk exceeds `maxChunkTokens`, split it (keeping at least 1 commit per chunk).
5. Assign a deterministic `TextUnitId` based on the commit hashes included (for incremental indexing dedup).

### 3. Extractor (`src/pipeline/extractor.ts`)

Uses LLM calls to extract entities and relationships from text units.

```typescript
interface ExtractorResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

interface ExtractedEntity {
  name: string;
  type: EntityType;
  description: string;
}

interface ExtractedRelation {
  source: string;          // Entity name
  target: string;          // Entity name
  type: RelationType;
  description: string;
  weight: number;          // 1-10 confidence
}

interface Extractor {
  /** Extract entities and relations from a single text unit */
  extract(textUnit: TextUnit): Promise<ExtractorResult>;

  /** Extract from multiple text units with concurrency control */
  extractBatch(
    textUnits: TextUnit[],
    options: { concurrency: number; onProgress?: (done: number, total: number) => void }
  ): AsyncIterable<{ textUnitId: TextUnitId; result: ExtractorResult }>;
}
```

**Key behaviors:**
- Uses the extraction prompt from PROMPTS.md with structured XML output.
- Runs up to `maxConcurrency` parallel API calls.
- Implements exponential backoff on rate limit errors.
- Reports progress via callback for CLI display.
- Each extraction call uses `claude-sonnet-4-20250514` (fast + cheap) — not Opus.
- Gleaning: optionally makes a second pass asking "did you miss anything?" to catch low-salience entities.

### 4. Resolver (`src/pipeline/resolver.ts`)

Deduplicates entities that refer to the same real-world concept.

```typescript
interface Resolver {
  /** Resolve entities, merging duplicates. Returns canonical entity list. */
  resolve(entities: ExtractedEntity[], threshold: number): Entity[];
}
```

**Resolution strategy:**
1. **Exact match:** Same name + type → merge.
2. **Alias match:** Known aliases (e.g., "React" = "ReactJS" = "react") → merge.
3. **Fuzzy match:** Jaro-Winkler similarity > threshold on name → candidate for merge.
4. **Module path normalization:** `src/billing/index.ts` → `src/billing` (directory-level grouping configurable).
5. **Person resolution:** Match by email (primary key), merge name variants.
6. Merged entities accumulate aliases and combine descriptions.

### 5. Graph Builder (`src/pipeline/graph-builder.ts`)

Assembles the resolved entities and relations into the graph store.

```typescript
interface GraphBuilder {
  /** Build or update the graph from extraction results */
  build(
    textUnits: TextUnit[],
    entities: Entity[],
    relations: Relation[]
  ): Promise<GraphStats>;
}

interface GraphStats {
  entityCount: number;
  relationCount: number;
  textUnitCount: number;
  edgeDensity: number;
}
```

**Key behaviors:**
- Upserts entities (merges with existing on conflict).
- Accumulates relation weights for repeated observations.
- Builds the FTS5 indexes.
- Stores co-change edges: if files A and B are modified in the same commit, create/strengthen a CO_CHANGED relation.

### 6. Clusterer (`src/pipeline/clusterer.ts`)

Detects communities in the entity graph using Louvain algorithm.

```typescript
interface Clusterer {
  /** Run community detection at multiple resolutions */
  cluster(
    entities: Entity[],
    relations: Relation[],
    resolutions: number[]
  ): Community[];
}
```

**Implementation:**
- Uses `graphology` + `graphology-communities-louvain` (Louvain — pure JS, no native deps).
- Runs at each configured resolution to produce a hierarchy.
- Filters out communities smaller than `minCommunitySize`.
- Links parent/child communities across levels.
- Each community gets a deterministic ID: `comm:{level}:{index}`.

### 7. Summarizer (`src/pipeline/summarizer.ts`)

Generates natural-language summaries for each community.

```typescript
interface Summarizer {
  /** Generate summary for a single community */
  summarize(community: Community, memberEntities: Entity[], memberRelations: Relation[]): Promise<string>;

  /** Summarize all communities with concurrency control */
  summarizeBatch(
    communities: Community[],
    entities: Entity[],
    relations: Relation[],
    options: { concurrency: number }
  ): AsyncIterable<{ communityId: CommunityId; summary: string }>;
}
```

**Key behaviors:**
- Uses the community summary prompt from PROMPTS.md.
- Includes member entity names, descriptions, and key relationships in the prompt.
- For coarser levels (level > 0), includes child community summaries instead of raw entities.
- Summaries are stored in the communities table and indexed in FTS5.

## Query Engine

### Local Search (`src/query/local-search.ts`)

Answers specific, entity-centric questions by starting from relevant entities and traversing the graph.

```typescript
interface LocalSearchOptions {
  query: string;
  maxEntities?: number;       // Default: 10
  maxRelations?: number;      // Default: 20
  maxTextUnits?: number;      // Default: 5
  entityTypes?: EntityType[]; // Filter to specific types
}

interface LocalSearchResult {
  entities: Entity[];
  relations: Relation[];
  textUnits: TextUnit[];       // Supporting evidence
  communities: Community[];    // Relevant community context
}

interface LocalSearch {
  search(options: LocalSearchOptions): LocalSearchResult;
}
```

**Algorithm:**
1. FTS5 search across `entities_fts` to find starting entities.
2. Expand 1-2 hops via relations to find related entities.
3. Rank by relevance (FTS score × entity frequency × recency).
4. Fetch supporting text units from the matched entities.
5. Include community summaries for the matched entities' communities.
6. Return structured data — the host agent (Claude) synthesizes the narrative.

### Global Search (`src/query/global-search.ts`)

Answers broad, thematic questions by searching across community summaries.

```typescript
interface GlobalSearchOptions {
  query: string;
  communityLevel?: number;    // Default: highest available
  maxCommunities?: number;    // Default: 5
}

interface GlobalSearchResult {
  communities: Community[];
  relevanceScores: number[];
}

interface GlobalSearch {
  search(options: GlobalSearchOptions): GlobalSearchResult;
}
```

**Algorithm:**
1. FTS5 search across `communities_fts` at the specified level.
2. Rank by relevance score.
3. Return top communities with their summaries.
4. The host agent synthesizes a narrative from the summaries.

### Graph Operations (`src/query/graph-ops.ts`)

Direct graph queries that don't need LLM synthesis.

```typescript
interface GraphOps {
  /** Find the top N experts for a module (by authorship weight × recency) */
  findExperts(modulePath: string, topN?: number): ExpertResult[];

  /** Show modules that co-change with the given module */
  getCoupling(modulePath: string, minWeight?: number): CouplingResult[];

  /** Get shortest path between two entities */
  getPath(fromId: EntityId, toId: EntityId): PathResult;

  /** Get graph statistics */
  getStats(): GraphStats;

  /** Get entity by ID or name search */
  getEntity(query: string): Entity | null;
}

interface ExpertResult {
  person: Entity;
  score: number;           // Weighted score
  commitCount: number;
  lastActive: string;
  modules: string[];       // Which sub-modules they've touched
}

interface CouplingResult {
  module: Entity;
  coChangeCount: number;
  coChangeRatio: number;   // Relative to total changes
  sharedAuthors: string[];
}
```

## MCP Server

### Tools (`src/mcp/tools.ts`)

```typescript
const tools = [
  {
    name: "hald_query",
    description: "Answer a free-form question about the repository's history, architecture, decisions, and team knowledge using the Hald knowledge graph. Returns structured context that you should synthesize into a helpful narrative.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to answer" },
        search_type: {
          type: "string",
          enum: ["local", "global", "auto"],
          description: "local = entity-centric (who/what questions), global = thematic (why/how questions), auto = let the system decide",
          default: "auto"
        }
      },
      required: ["question"]
    }
  },
  {
    name: "hald_find_expert",
    description: "Find the people with the most knowledge about a specific module, file, or area of the codebase. Returns ranked experts with their activity details.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string", description: "File path, directory, or module name to find experts for" },
        top_n: { type: "number", description: "Number of experts to return", default: 5 }
      },
      required: ["module"]
    }
  },
  {
    name: "hald_trace_decision",
    description: "Trace the history of an architectural or technical decision. Returns the timeline of commits, people involved, and context.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The decision or migration to trace (e.g., 'REST to gRPC migration', 'TypeScript adoption')" }
      },
      required: ["topic"]
    }
  },
  {
    name: "hald_show_coupling",
    description: "Show which modules/files tend to change together, indicating architectural coupling.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string", description: "File path or directory to analyze coupling for" },
        min_co_changes: { type: "number", description: "Minimum number of co-changes to include", default: 3 }
      },
      required: ["module"]
    }
  },
  {
    name: "hald_index",
    description: "Index or re-index the current repository. Run this before querying if the index doesn't exist or is stale.",
    inputSchema: {
      type: "object",
      properties: {
        full: { type: "boolean", description: "Force full re-index (vs incremental)", default: false },
        max_commits: { type: "number", description: "Limit number of commits to index" },
        since_date: { type: "string", description: "Only index commits after this date (ISO format)" }
      }
    }
  },
  {
    name: "hald_stats",
    description: "Get statistics about the current Hald index.",
    inputSchema: { type: "object", properties: {} }
  }
];
```

### Resources (`src/mcp/resources.ts`)

```typescript
const resources = [
  {
    uri: "hald://stats",
    name: "Hald Index Statistics",
    description: "Current index stats: entity count, relation count, last indexed commit, etc.",
    mimeType: "application/json"
  },
  {
    uri: "hald://graph/summary",
    name: "Graph Summary",
    description: "High-level summary of the knowledge graph structure and top communities.",
    mimeType: "text/plain"
  }
];
```

## Platform Shims

Hald follows the Superpowers pattern: **one set of skills, one MCP server, multiple platform-specific shims.** Each platform has its own mechanism for plugin discovery, but the actual functionality is identical everywhere.

### Cross-Platform Bootstrap (`hooks/session-start.sh`)

A POSIX-safe shell script that runs on session start. It detects the platform and injects the hald skills into the agent's context.

```bash
#!/bin/sh
# Detect platform from environment variables
if [ -n "$CLAUDE_PLUGIN_ROOT" ] && [ -z "$CURSOR_PLUGIN_ROOT" ]; then
  PLATFORM="claude-code"
  PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"
elif [ -n "$CURSOR_PLUGIN_ROOT" ]; then
  PLATFORM="cursor"
  PLUGIN_ROOT="$CURSOR_PLUGIN_ROOT"
else
  PLATFORM="generic"
  PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi

# Read the query skill content
SKILL_CONTENT=$(cat "$PLUGIN_ROOT/skills/hald-query/SKILL.md")

# Emit platform-appropriate JSON
# Claude Code uses hookSpecificOutput, Cursor uses additional_context
if [ "$PLATFORM" = "claude-code" ]; then
  printf '{"hookSpecificOutput": "%s"}' "$(echo "$SKILL_CONTENT" | sed 's/"/\\"/g' | tr '\n' ' ')"
elif [ "$PLATFORM" = "cursor" ]; then
  printf '{"additional_context": "%s"}' "$(echo "$SKILL_CONTENT" | sed 's/"/\\"/g' | tr '\n' ' ')"
fi
```

### Claude Code (`.claude-plugin/plugin.json`)

```json
{
  "name": "hald",
  "description": "GraphRAG-powered knowledge graph for your git history. Ask questions about architectural decisions, find domain experts, trace code evolution, and surface hidden coupling.",
  "version": "0.1.0",
  "author": { "name": "Gabriel" },
  "homepage": "https://github.com/gabriel/hald",
  "repository": "https://github.com/gabriel/hald",
  "license": "MIT",
  "keywords": ["graphrag", "git", "knowledge-graph", "institutional-knowledge"]
}
```

### MCP Server Config (`.mcp.json` — Claude Code + Cursor)

```json
{
  "mcpServers": {
    "hald": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/index.js"],
      "env": {
        "HALD_REPO": "${CLAUDE_PROJECT_ROOT}"
      }
    }
  }
}
```

Note: No API key is hardcoded in `.mcp.json`. The MCP server auto-detects available keys from the environment at runtime. Claude Code, Cursor, and Codex all expose their respective API keys as environment variables.

### Cursor (`.cursor-plugin/plugin.json`)

```json
{
  "name": "hald",
  "description": "GraphRAG-powered knowledge graph for your git history.",
  "version": "0.1.0",
  "homepage": "https://github.com/gabriel/hald"
}
```

Cursor uses the same `.mcp.json` and `hooks/` as Claude Code.

### Codex (`.codex/INSTALL.md`)

Codex requires manual setup. The INSTALL.md is designed to be read by the agent itself:

```markdown
# Installing Hald for Codex

1. Clone the repository:
   git clone https://github.com/gabriel/hald.git ~/.codex/hald

2. Install dependencies and build:
   cd ~/.codex/hald && npm install && npm run build

3. Create skills symlink:
   ln -s ~/.codex/hald/skills ~/.agents/skills/hald

4. Add MCP server to your Codex config:
   Add this to your MCP servers configuration:
   {
     "hald": {
       "command": "node",
       "args": ["~/.codex/hald/dist/index.js"]
     }
   }

5. Restart Codex.
```

### OpenCode (`.opencode/plugins/hald.js`)

A JavaScript plugin that registers skills and the MCP server:

```javascript
// OpenCode plugin: auto-registers skills + MCP server
const path = require("path");
const fs = require("fs");

module.exports = function haldPlugin() {
  const pluginRoot = path.resolve(__dirname, "../..");

  return {
    name: "hald",

    config(config) {
      // Register skills directory for OpenCode's discovery
      const skillsDir = path.join(pluginRoot, "skills");
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      config.skills.paths.push(skillsDir);
      return config;
    },

    "experimental.chat.system.transform"(system) {
      // Inject hald awareness at session start
      const skillPath = path.join(pluginRoot, "skills/hald-query/SKILL.md");
      try {
        const content = fs.readFileSync(skillPath, "utf-8");
        return `${system}\n\n<hald-skills>\n${content}\n</hald-skills>`;
      } catch {
        return system;
      }
    }
  };
};
```

### Gemini CLI (`gemini-extension.json`)

```json
{
  "name": "hald",
  "description": "GraphRAG-powered knowledge graph for git history",
  "skills_dir": "skills"
}
```

Plus a `GEMINI.md` at the repo root with tool name mappings (Gemini uses `read_file`/`write_file` instead of `Read`/`Write`).

### Platform Support Matrix

| Platform | Plugin Discovery | MCP Support | Skills Injection | API Key Source |
|----------|-----------------|-------------|------------------|----------------|
| Claude Code | `.claude-plugin/` marketplace | Native via `.mcp.json` | `hooks/session-start.sh` → `hookSpecificOutput` | `ANTHROPIC_API_KEY` (always present) |
| Cursor | `.cursor-plugin/` marketplace | Native via `.mcp.json` | `hooks/session-start.sh` → `additional_context` | `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` |
| Codex | Manual `.codex/INSTALL.md` | Via config file | Skills symlink to `~/.agents/skills/` | `OPENAI_API_KEY` (always present) |
| OpenCode | `.opencode/plugins/` JS hook | Via plugin config | `experimental.chat.system.transform` | Varies (user-configured) |
| Gemini CLI | `gemini-extension.json` | Limited | `GEMINI.md` + skills dir | `GOOGLE_API_KEY` / `GEMINI_API_KEY` |

## LLM Client (`src/llm/`)

### Architecture

The LLM client uses a provider-agnostic interface. The pipeline doesn't know or care which LLM provider is being used — it calls `extract()` and gets structured text back.

```typescript
// === Abstract Interface (src/llm/types.ts) ===

type LLMProvider = "anthropic" | "openai" | "google";

interface LLMClient {
  /** The detected/configured provider */
  readonly provider: LLMProvider;

  /** Send a structured extraction request, returns raw text response */
  extract(prompt: string, systemPrompt: string, options?: LLMRequestOptions): Promise<LLMResponse>;
}

interface LLMRequestOptions {
  temperature?: number;       // Default: 0 (deterministic extraction)
  maxTokens?: number;         // Default: 4096
}

interface LLMResponse {
  text: string;               // Raw response text
  inputTokens: number;        // For cost tracking
  outputTokens: number;       // For cost tracking
  model: string;              // Actual model used
}

interface LLMClientConfig {
  provider: LLMProvider | "auto";
  model?: string;              // Provider-specific model; auto-selected if omitted
  apiKey?: string;             // Explicit key; env var fallback per provider
  baseUrl?: string;            // Custom endpoint (Ollama, OpenRouter, Azure, etc.)
  maxRetries: number;
}
```

### Provider Implementations

Each provider lives in its own file and implements `LLMClient`:

| File | Provider | SDK | Env Var | Default Model |
|------|----------|-----|---------|---------------|
| `anthropic.ts` | Anthropic | `@anthropic-ai/sdk` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` |
| `openai.ts` | OpenAI-compatible | `openai` | `OPENAI_API_KEY` | `gpt-4.1-mini` |
| `google.ts` | Google | `@google/genai` | `GOOGLE_API_KEY` or `GEMINI_API_KEY` | `gemini-2.5-flash` |

The OpenAI provider supports any OpenAI-compatible endpoint via `baseUrl`:
- **OpenRouter:** `baseUrl: "https://openrouter.ai/api/v1"` — access any model
- **Ollama:** `baseUrl: "http://localhost:11434/v1"` — fully local, zero cost
- **Azure OpenAI:** `baseUrl: "https://<instance>.openai.azure.com"` — enterprise

### Auto-Detection (`src/llm/client.ts`)

When `provider` is `"auto"` (the default), the client factory detects available credentials:

```typescript
function detectProvider(): { provider: LLMProvider; apiKey: string } | null {
  // Priority order: Anthropic > OpenAI > Google
  // Rationale: Claude Code users (primary audience) have Anthropic keys;
  //            Codex/Cursor users often have OpenAI keys;
  //            Gemini CLI users have Google keys.

  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: "openai", apiKey: process.env.OPENAI_API_KEY };
  }
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) {
    return {
      provider: "google",
      apiKey: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY!
    };
  }

  return null; // No provider found — fall back to agent-mediated mode
}

function createClient(config: LLMClientConfig): LLMClient {
  if (config.provider === "auto") {
    const detected = detectProvider();
    if (!detected) {
      throw new NoProviderError(
        "No LLM API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY. " +
        "Alternatively, run indexing via the MCP tool from your coding agent."
      );
    }
    return createProviderClient(detected.provider, { ...config, apiKey: detected.apiKey });
  }
  return createProviderClient(config.provider, config);
}
```

### Agent-Mediated Fallback

When no API key is available, the MCP `hald_index` tool falls back to **agent-mediated mode**: instead of making direct API calls, it returns text unit content to the host agent and asks it to extract entities. This is slower (sequential tool calls, fills context window) but requires zero configuration — the agent's own tokens do all the work.

The tool handler detects this scenario:
```typescript
// In src/mcp/tools.ts — hald_index handler
const client = tryCreateClient(config);
if (client) {
  // Direct mode: batch extraction via API
  await pipeline.indexDirect(client, options);
} else {
  // Agent-mediated mode: return chunks for the agent to process
  return {
    content: [{
      type: "text",
      text: `No API key detected. I'll return commit data in chunks for you to extract entities from.
             Process each chunk and call hald_ingest_entities with the results.\n\n` +
             `Chunk 1/${totalChunks}:\n${firstChunk.content}`
    }]
  };
}
```

### All providers share the same behavior:
- Exponential backoff on rate limits (1s, 2s, 4s, 8s)
- Token usage logging for cost tracking
- Timeout: 30s per request
- Same prompts across all providers (XML structured output works with all)

## Configuration (`src/shared/config.ts`)

Configuration is loaded from (in priority order):
1. CLI flags / tool input parameters
2. `.hald/config.json` in the repo root
3. Environment variables (`HALD_*`)
4. Defaults

```typescript
// Default config
const defaults: HaldConfig = {
  repoPath: ".",
  branch: "HEAD",
  commitsPerChunk: 10,
  maxChunkTokens: 2000,
  provider: "auto",            // Auto-detect from available API keys
  // model: undefined,         // Auto-selected per provider (see table above)
  maxConcurrency: 5,
  maxRetries: 3,
  entityResolutionThreshold: 0.85,
  communityResolutions: [0.5, 1.0, 2.0],
  minCommunitySize: 3,
  storagePath: ".hald",
};
```

## Incremental Indexing

The system supports efficient incremental indexing:

1. On first run: full index of all commits (or up to `maxCommits`).
2. On subsequent runs:
   a. Read `last_indexed_commit` from `index_meta`.
   b. Get new commits since that hash.
   c. Create new text units only for new commits.
   d. Run extraction only on new text units.
   e. Run resolution across ALL entities (new + existing) — new entities may merge with existing ones.
   f. Rebuild graph (upsert mode).
   g. Re-run clustering on the full graph.
   h. Re-summarize only communities whose membership changed.
   i. Update `last_indexed_commit`.

This means re-indexing after a `git pull` with 50 new commits should take seconds for extraction and a few more seconds for clustering + summary updates.

## Shared Storage (Optional Team Sync)

The `.hald/` directory contains:
```
.hald/
├── config.json       # Index configuration
├── oracle.db         # SQLite database
└── meta.json         # Index metadata (version, last commit, stats)
```

**Option A — Commit to repo:** Add `.hald/` to the repo. Team members get a pre-built graph.
**Option B — .gitignore + export:** Keep `.hald/` in `.gitignore`, provide `hald export` / `hald import` commands for sharing via S3, GCS, or a shared drive.
**Option C — Re-index locally:** Each developer runs their own index. Fast for small/medium repos.

## Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "openai": "^4.80.0",
    "@google/genai": "^1.0.0",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "better-sqlite3": "^11.0.0",
    "simple-git": "^3.27.0",
    "graphology": "^0.25.4",
    "graphology-communities-louvain": "^2.0.1",
    "graphology-metrics": "^2.3.0",
    "commander": "^12.0.0",
    "fast-xml-parser": "^4.5.0",
    "jaro-winkler": "^0.2.8",
    "p-limit": "^6.0.0",
    "tiktoken": "^1.0.18",
    "ora": "^8.0.0",
    "chalk": "^5.3.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.0.0",
    "tsup": "^8.0.0"
  }
}
```

Note: All three provider SDKs are listed as dependencies but are lazily imported — only the detected provider's SDK is loaded at runtime. Users who only use one provider won't see errors from missing peer dependencies of unused SDKs.

## Implementation Order

The following is the recommended build sequence. Each step should be implemented, tested, and committed before moving to the next.

### Foundation (Steps 1–7)
1. **Project scaffold** — `package.json`, `tsconfig.json`, `tsup.config.ts`, directory structure, `.gitignore`
2. **Shared types** — `src/shared/types.ts` with all interfaces and enums
3. **Config loader** — `src/shared/config.ts`, default values, env var reading, JSON file loading, provider auto-detection logic
4. **Logger** — `src/shared/logger.ts`, structured logging with levels and timing
5. **SQLite store** — `src/store/db.ts` (connection management), `src/store/schema.ts` (table creation + migration), `src/store/queries.ts` (prepared statements for CRUD)
6. **LLM client abstraction** — `src/llm/types.ts` (interface), `src/llm/client.ts` (factory with auto-detection)
7. **LLM providers** — `src/llm/anthropic.ts`, `src/llm/openai.ts`, `src/llm/google.ts` (each with retry logic, token tracking)

### Pipeline (Steps 8–14)
8. **Git reader** — `src/pipeline/git-reader.ts`, tests with a fixture repo
9. **Chunker** — `src/pipeline/chunker.ts`, tests with sample commits
10. **Extractor** — `src/pipeline/extractor.ts`, integration test with real LLM call (any available provider)
11. **Resolver** — `src/pipeline/resolver.ts`, tests for exact/fuzzy/email matching
12. **Graph builder** — `src/pipeline/graph-builder.ts`, tests for upsert behavior
13. **Clusterer** — `src/pipeline/clusterer.ts`, tests with a small synthetic graph
14. **Summarizer** — `src/pipeline/summarizer.ts`, integration test with real LLM call

### Query (Steps 15–18)
15. **Graph operations** — `src/query/graph-ops.ts` (findExperts, getCoupling, getPath, getStats)
16. **Local search** — `src/query/local-search.ts`, tests with indexed fixture data
17. **Global search** — `src/query/global-search.ts`, tests with indexed fixture data
18. **CLI** — `src/cli.ts` with `index`, `query`, and `stats` subcommands (useful for testing)

### MCP Server (Steps 19–21)
19. **MCP server** — `src/mcp/server.ts`, `src/mcp/tools.ts`, `src/mcp/resources.ts`
20. **Tool handlers** — Wire tools to query engine, implement agent-mediated fallback, test via MCP inspector
21. **Integration test** — Full pipeline: index fixture repo → query via MCP tools

### Platform Shims (Steps 22–26)
22. **Claude Code plugin** — `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/session-start.sh`
23. **Cursor plugin** — `.cursor-plugin/plugin.json` (shares `.mcp.json` and `hooks/`)
24. **Skills** — `skills/hald-query/SKILL.md`, `skills/hald-index/SKILL.md`
25. **OpenCode plugin** — `.opencode/plugins/hald.js`, `.opencode/INSTALL.md`
26. **Codex + Gemini** — `.codex/INSTALL.md`, `gemini-extension.json`, `GEMINI.md`

### Polish (Steps 27–30)
27. **Incremental indexing** — Detect new commits, process only delta
28. **Progress reporting** — CLI spinner + progress bar for indexing
29. **Cost estimation** — Pre-index token count estimation and cost display per provider
30. **README + npm publish config** — Documentation, `npx hald` entry point, installation instructions for all 5 platforms
