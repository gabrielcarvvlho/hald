// Mock data provider for the graph viewer. Lets us iterate on the
// visualization (layout, colors, sidebar, overlays) without needing
// a real index. Entities and relations are modeled after a fake
// codebase so the resulting graph has realistic shape: a few hub
// people, several module clusters, cross-cutting technologies, and
// a couple of decision/pattern nodes that bridge communities.
//
// Usage: `hald graph --mock` — wires this module as the data provider
// instead of the SQLite store.

import graphologyPkg from "graphology";
const { UndirectedGraph } = graphologyPkg as unknown as {
  UndirectedGraph: typeof import("graphology").UndirectedGraph;
};
import fa2Module from "graphology-layout-forceatlas2";
const forceAtlas2 = fa2Module as unknown as {
  assign(
    graph: InstanceType<typeof UndirectedGraph>,
    options: { iterations: number; settings?: Record<string, unknown> },
  ): void;
};

import type {
  GraphCommunity,
  GraphEdge,
  GraphNode,
  GraphResponse,
  StatsResponse,
  EntityDetailResponse,
  EntityDetailRelation,
  CommunityDetailResponse,
} from "./api.js";
import type { VizDataProvider } from "./provider.js";

// ================================================================
// Color palette (mirrors api.ts so the viewer renders consistently)
// ================================================================

const COMMUNITY_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
];

// ================================================================
// Raw mock fixtures
// ================================================================

interface MockEntity {
  id: string;
  type: string;
  name: string;
  description: string;
  aliases: string[];
  frequency: number;
  firstSeen: string;
  lastSeen: string;
  community: string; // community id
}

interface MockRelation {
  source: string;
  target: string;
  type: string;
  weight: number;
  description: string;
}

interface MockCommunity {
  id: string;
  title: string;
  summary: string;
}

const MOCK_COMMUNITIES: MockCommunity[] = [
  {
    id: "c-pipeline",
    title: "Indexing Pipeline",
    summary:
      "End-to-end commit processing — git reader streams commits, chunker groups them into text units, extractor calls the LLM for entities and relations, summarizer rolls communities up into prose.",
  },
  {
    id: "c-storage",
    title: "Storage & Search",
    summary:
      "SQLite persistence with FTS5 full-text search. Synchronous better-sqlite3 driver, schema migrations, and the query layer that backs both the MCP tools and the graph viewer.",
  },
  {
    id: "c-mcp",
    title: "MCP Server & Tooling",
    summary:
      "Model Context Protocol surface. Exposes graph queries as tools and prompts so coding agents (Claude, Cursor, Codex, Gemini) can ask structured questions about the repo.",
  },
  {
    id: "c-llm",
    title: "LLM Providers",
    summary:
      "Provider-agnostic client. Auto-detects API keys for Anthropic, OpenAI, and Google. Same prompts, same XML parsing, lazy-imported SDKs to keep cold start fast.",
  },
  {
    id: "c-viz",
    title: "Graph Visualization",
    summary:
      "Browser-based explorer. Sigma.js + Graphology with a ForceAtlas2 layout, community-colored nodes, a sidebar for entity detail, and a cluster overlay for the explain-this-cluster flow.",
  },
  {
    id: "c-quality",
    title: "Quality & Build",
    summary:
      "Test suites, fixture repos, type-check and lint gates, and the tsup bundler. The connective tissue that lets the rest of the codebase ship without regressions.",
  },
];

// People — a small core team. Hubs, so they get higher frequency.
const PEOPLE: MockEntity[] = [
  mkEntity(
    "p-alice",
    "PERSON",
    "Alice Chen",
    "Tech lead. Pipeline architect — owns extraction, chunking, and the LLM-output schema.",
    "c-pipeline",
    142,
    ["alice", "achen", "alice@hald.dev"],
  ),
  mkEntity(
    "p-bob",
    "PERSON",
    "Bob Martinez",
    "Storage engineer. Schema, migrations, FTS5, and the better-sqlite3 query layer.",
    "c-storage",
    98,
    ["bob", "bob@hald.dev"],
  ),
  mkEntity(
    "p-clara",
    "PERSON",
    "Clara Liu",
    "MCP & integrations lead. Cross-platform shims and the tool/resource surface.",
    "c-mcp",
    87,
    ["clara", "clara@hald.dev"],
  ),
  mkEntity(
    "p-david",
    "PERSON",
    "David Park",
    "Provider abstraction owner. Anthropic, OpenAI, and Google adapters; lazy-loading SDKs.",
    "c-llm",
    64,
    ["david", "dpark", "david@hald.dev"],
  ),
  mkEntity(
    "p-eli",
    "PERSON",
    "Eli Singh",
    "Frontend / viz. Sigma renderer, sidebar, theming, and the explain-this-cluster overlay.",
    "c-viz",
    53,
    ["eli", "eli@hald.dev"],
  ),
  mkEntity(
    "p-fran",
    "PERSON",
    "Fran Costa",
    "Quality & DX. Vitest suites, fixture repos, lint/type gates, and CLI ergonomics.",
    "c-quality",
    41,
    ["fran", "fran@hald.dev"],
  ),
];

// Modules — primary clusters of code activity.
const MODULES: MockEntity[] = [
  mkEntity(
    "m-extractor",
    "MODULE",
    "src/pipeline/extractor",
    "LLM-based entity & relation extractor.",
    "c-pipeline",
    78,
  ),
  mkEntity(
    "m-chunker",
    "MODULE",
    "src/pipeline/chunker",
    "Groups commits into text units for extraction.",
    "c-pipeline",
    52,
  ),
  mkEntity(
    "m-clusterer",
    "MODULE",
    "src/pipeline/clusterer",
    "Louvain community detection over the entity graph.",
    "c-pipeline",
    44,
  ),
  mkEntity(
    "m-summarizer",
    "MODULE",
    "src/pipeline/summarizer",
    "Rolls each community up into a human-readable summary.",
    "c-pipeline",
    39,
  ),
  mkEntity(
    "m-gitreader",
    "MODULE",
    "src/pipeline/gitReader",
    "Streams commits via simple-git as an AsyncIterable.",
    "c-pipeline",
    36,
  ),
  mkEntity(
    "m-store",
    "MODULE",
    "src/store/queries",
    "All read paths against SQLite — entities, relations, communities, FTS.",
    "c-storage",
    91,
  ),
  mkEntity(
    "m-schema",
    "MODULE",
    "src/store/schema",
    "Schema definition and FTS5 virtual tables.",
    "c-storage",
    34,
  ),
  mkEntity(
    "m-migrations",
    "MODULE",
    "src/store/migrations",
    "Versioned schema migrations.",
    "c-storage",
    18,
  ),
  mkEntity(
    "m-mcp-server",
    "MODULE",
    "src/mcp/server",
    "MCP server bootstrap, tool registration, stdio transport.",
    "c-mcp",
    67,
  ),
  mkEntity(
    "m-mcp-tools",
    "MODULE",
    "src/mcp/tools",
    "Tool implementations: search, explain, neighbors.",
    "c-mcp",
    58,
  ),
  mkEntity(
    "m-mcp-resources",
    "MODULE",
    "src/mcp/resources",
    "Static resources exposed to clients.",
    "c-mcp",
    22,
  ),
  mkEntity(
    "m-llm-client",
    "MODULE",
    "src/llm/client",
    "Unified LLM client with provider auto-detection.",
    "c-llm",
    71,
  ),
  mkEntity(
    "m-llm-anthropic",
    "MODULE",
    "src/llm/anthropic",
    "Anthropic Claude provider adapter.",
    "c-llm",
    33,
  ),
  mkEntity(
    "m-llm-openai",
    "MODULE",
    "src/llm/openai",
    "OpenAI GPT provider adapter.",
    "c-llm",
    29,
  ),
  mkEntity(
    "m-llm-google",
    "MODULE",
    "src/llm/google",
    "Google Gemini provider adapter.",
    "c-llm",
    21,
  ),
  mkEntity(
    "m-viz-server",
    "MODULE",
    "src/viz/server",
    "Static file + JSON API HTTP server for the explorer.",
    "c-viz",
    47,
  ),
  mkEntity(
    "m-viz-app",
    "MODULE",
    "src/viz/public/app",
    "Browser app: Sigma.js renderer, sidebar, search, theme.",
    "c-viz",
    62,
  ),
  mkEntity(
    "m-viz-api",
    "MODULE",
    "src/viz/api",
    "Server-side data shaping for the graph viewer.",
    "c-viz",
    35,
  ),
  mkEntity(
    "m-tests",
    "MODULE",
    "tests/",
    "Vitest suites and fixture repos.",
    "c-quality",
    74,
  ),
  mkEntity(
    "m-cli",
    "MODULE",
    "src/cli",
    "CLI entry point — scan, ask, graph, serve.",
    "c-quality",
    56,
  ),
];

// Technologies — many cross-cutting, so they bridge communities.
const TECHS: MockEntity[] = [
  mkEntity(
    "t-typescript",
    "TECHNOLOGY",
    "TypeScript",
    "Strict-mode TypeScript across all source.",
    "c-quality",
    134,
  ),
  mkEntity("t-node", "TECHNOLOGY", "Node.js", "Runtime.", "c-quality", 89),
  mkEntity(
    "t-sqlite",
    "TECHNOLOGY",
    "SQLite",
    "Embedded database via better-sqlite3.",
    "c-storage",
    77,
  ),
  mkEntity(
    "t-fts5",
    "TECHNOLOGY",
    "FTS5",
    "Full-text search extension to SQLite.",
    "c-storage",
    24,
  ),
  mkEntity(
    "t-sigma",
    "TECHNOLOGY",
    "Sigma.js",
    "WebGL graph renderer.",
    "c-viz",
    41,
  ),
  mkEntity(
    "t-graphology",
    "TECHNOLOGY",
    "Graphology",
    "Pure-JS graph data structure.",
    "c-viz",
    32,
  ),
  mkEntity(
    "t-fa2",
    "TECHNOLOGY",
    "ForceAtlas2",
    "Layout algorithm.",
    "c-viz",
    19,
  ),
  mkEntity(
    "t-anthropic",
    "TECHNOLOGY",
    "Anthropic SDK",
    "Claude API client.",
    "c-llm",
    37,
  ),
  mkEntity(
    "t-openai",
    "TECHNOLOGY",
    "OpenAI SDK",
    "GPT API client.",
    "c-llm",
    31,
  ),
  mkEntity(
    "t-genai",
    "TECHNOLOGY",
    "Google GenAI",
    "Gemini API client.",
    "c-llm",
    23,
  ),
  mkEntity(
    "t-mcp-sdk",
    "TECHNOLOGY",
    "MCP SDK",
    "Model Context Protocol TypeScript SDK.",
    "c-mcp",
    46,
  ),
  mkEntity(
    "t-vitest",
    "TECHNOLOGY",
    "Vitest",
    "Test runner.",
    "c-quality",
    54,
  ),
  mkEntity(
    "t-tsup",
    "TECHNOLOGY",
    "tsup",
    "Bundler for distribution.",
    "c-quality",
    17,
  ),
  mkEntity(
    "t-simplegit",
    "TECHNOLOGY",
    "simple-git",
    "Git operations wrapper.",
    "c-pipeline",
    28,
  ),
  mkEntity(
    "t-fastxml",
    "TECHNOLOGY",
    "fast-xml-parser",
    "Parses XML output from extraction prompts.",
    "c-pipeline",
    14,
  ),
];

// Decisions and patterns — cross-cluster bridges.
const IDEAS: MockEntity[] = [
  mkEntity(
    "d-sqlite",
    "DECISION",
    "Use SQLite over Postgres",
    "Zero-infra single-file DB beats network deps for a CLI tool.",
    "c-storage",
    11,
  ),
  mkEntity(
    "d-providers",
    "DECISION",
    "Provider-agnostic LLM client",
    "Auto-detect available API key; fall back to agent-mediated mode.",
    "c-llm",
    9,
  ),
  mkEntity(
    "d-token-strategy",
    "DECISION",
    "Two-mode token strategy",
    "Indexing uses provider tokens; querying returns structured data only.",
    "c-mcp",
    14,
  ),
  mkEntity(
    "d-sync-db",
    "DECISION",
    "Synchronous DB ops",
    "Embrace better-sqlite3's sync API instead of fighting it.",
    "c-storage",
    7,
  ),
  mkEntity(
    "p-asynciter",
    "PATTERN",
    "AsyncIterable streaming",
    "Stream large datasets (commits, extraction) instead of buffering.",
    "c-pipeline",
    16,
  ),
  mkEntity(
    "p-lazyimport",
    "PATTERN",
    "Lazy SDK import",
    "Only load the detected provider's SDK at runtime.",
    "c-llm",
    8,
  ),
  mkEntity(
    "p-xmlout",
    "PATTERN",
    "Structured XML output",
    "Force the model to wrap entities/relations in XML tags for robust parsing.",
    "c-pipeline",
    12,
  ),
];

const ALL_ENTITIES: MockEntity[] = [...PEOPLE, ...MODULES, ...TECHS, ...IDEAS];

// Hand-authored relations. Mix of intra-community (dense within a
// cluster) and cross-community bridges (people working across modules,
// tech used everywhere, decisions touching multiple areas).
const RELATIONS: MockRelation[] = [
  // Authorship — people own modules
  rel("p-alice", "m-extractor", "AUTHORED", 38, "Primary author"),
  rel("p-alice", "m-chunker", "AUTHORED", 22, "Initial implementation"),
  rel("p-alice", "m-summarizer", "AUTHORED", 19, "Major refactor in March"),
  rel("p-alice", "m-gitreader", "MODIFIED", 11, "AsyncIterable refactor"),
  rel("p-bob", "m-store", "AUTHORED", 41, "Owns storage layer"),
  rel("p-bob", "m-schema", "AUTHORED", 18, "Schema design"),
  rel("p-bob", "m-migrations", "AUTHORED", 12, "Migration framework"),
  rel("p-clara", "m-mcp-server", "AUTHORED", 33, "MCP server bootstrap"),
  rel("p-clara", "m-mcp-tools", "AUTHORED", 27, "Tool implementations"),
  rel("p-clara", "m-mcp-resources", "MODIFIED", 9, "Resource exposure"),
  rel("p-david", "m-llm-client", "AUTHORED", 31, "Provider abstraction"),
  rel("p-david", "m-llm-anthropic", "AUTHORED", 14, "Claude adapter"),
  rel("p-david", "m-llm-openai", "AUTHORED", 13, "GPT adapter"),
  rel("p-david", "m-llm-google", "AUTHORED", 9, "Gemini adapter"),
  rel("p-eli", "m-viz-server", "AUTHORED", 21, "HTTP server"),
  rel("p-eli", "m-viz-app", "AUTHORED", 28, "Browser frontend"),
  rel("p-eli", "m-viz-api", "AUTHORED", 16, "Data shaping"),
  rel("p-fran", "m-tests", "AUTHORED", 47, "Test suite owner"),
  rel("p-fran", "m-cli", "MODIFIED", 18, "CLI commands"),

  // Cross-cluster authorship — bridges
  rel("p-alice", "m-store", "MODIFIED", 8, "Pipeline writes via store"),
  rel("p-clara", "m-store", "MODIFIED", 11, "MCP tools query store"),
  rel("p-eli", "m-store", "MODIFIED", 6, "Viz reads from store"),
  rel("p-david", "m-extractor", "MODIFIED", 13, "LLM integration"),
  rel("p-fran", "m-extractor", "MODIFIED", 7, "Test coverage"),
  rel("p-alice", "p-bob", "CO_CHANGED", 14, "Pair on storage interface"),
  rel("p-clara", "p-david", "CO_CHANGED", 9, "MCP tool ↔ LLM client"),

  // Module → Module dependencies
  rel("m-extractor", "m-llm-client", "USES", 24, "Calls extraction prompts"),
  rel("m-extractor", "m-chunker", "DEPENDS_ON", 18, "Consumes text units"),
  rel("m-summarizer", "m-llm-client", "USES", 17, "Community summaries"),
  rel("m-clusterer", "m-store", "DEPENDS_ON", 14, "Reads entities & relations"),
  rel("m-mcp-tools", "m-store", "DEPENDS_ON", 32, "All tools read from store"),
  rel("m-mcp-server", "m-mcp-tools", "DEPENDS_ON", 19, "Registers tools"),
  rel("m-mcp-server", "m-mcp-resources", "DEPENDS_ON", 11, "Registers resources"),
  rel("m-viz-server", "m-viz-api", "DEPENDS_ON", 13, "Serves shaped data"),
  rel("m-viz-api", "m-store", "DEPENDS_ON", 17, "Queries entities/communities"),
  rel("m-viz-app", "m-viz-server", "DEPENDS_ON", 9, "HTTP API client"),
  rel("m-llm-client", "m-llm-anthropic", "USES", 11, "Provider dispatch"),
  rel("m-llm-client", "m-llm-openai", "USES", 9, "Provider dispatch"),
  rel("m-llm-client", "m-llm-google", "USES", 7, "Provider dispatch"),
  rel("m-cli", "m-viz-server", "USES", 5, "graph subcommand"),
  rel("m-cli", "m-mcp-server", "USES", 6, "serve subcommand"),
  rel("m-store", "m-schema", "DEPENDS_ON", 22, "Schema source of truth"),
  rel("m-store", "m-migrations", "DEPENDS_ON", 13, "Runs migrations on open"),
  rel("m-gitreader", "m-chunker", "DEPENDS_ON", 12, "Streams to chunker"),

  // Tech adoption
  rel("m-extractor", "t-typescript", "USES", 12, "Strict TS"),
  rel("m-store", "t-sqlite", "USES", 28, "better-sqlite3"),
  rel("m-schema", "t-fts5", "USES", 14, "FTS5 virtual tables"),
  rel("m-viz-app", "t-sigma", "USES", 21, "WebGL renderer"),
  rel("m-viz-app", "t-graphology", "USES", 14, "Graph data structure"),
  rel("m-viz-api", "t-fa2", "USES", 11, "Layout"),
  rel("m-llm-anthropic", "t-anthropic", "USES", 12, "SDK wrap"),
  rel("m-llm-openai", "t-openai", "USES", 11, "SDK wrap"),
  rel("m-llm-google", "t-genai", "USES", 9, "SDK wrap"),
  rel("m-mcp-server", "t-mcp-sdk", "USES", 18, "MCP SDK"),
  rel("m-tests", "t-vitest", "USES", 31, "All test files"),
  rel("m-cli", "t-tsup", "USES", 8, "Bundles for distribution"),
  rel("m-gitreader", "t-simplegit", "USES", 13, "Git wrapper"),
  rel("m-extractor", "t-fastxml", "USES", 9, "Parse LLM output"),

  // TypeScript / Node touch nearly everything (cross-community bridges)
  rel("m-store", "t-typescript", "USES", 14, "Typed query layer"),
  rel("m-mcp-server", "t-typescript", "USES", 12, "Typed tools"),
  rel("m-llm-client", "t-typescript", "USES", 11, "Typed provider interface"),
  rel("m-viz-app", "t-typescript", "USES", 9, "Type checked"),
  rel("m-cli", "t-node", "USES", 8, "Node runtime"),
  rel("m-store", "t-node", "USES", 7, "Node runtime"),
  rel("m-mcp-server", "t-node", "USES", 6, "Node runtime"),

  // Decisions and patterns — cross-cluster bridges
  rel("d-sqlite", "m-store", "DECIDED", 8, "Why SQLite was chosen"),
  rel("d-sqlite", "t-sqlite", "DECIDED", 6, "Tech selection"),
  rel("d-providers", "m-llm-client", "DECIDED", 7, "Multi-provider design"),
  rel("d-providers", "t-anthropic", "DECIDED", 4, "First provider"),
  rel("d-token-strategy", "m-mcp-tools", "DECIDED", 9, "Tools return data, not prose"),
  rel("d-token-strategy", "m-extractor", "DECIDED", 6, "Indexing pays the tokens"),
  rel("d-sync-db", "m-store", "DECIDED", 5, "Embrace sync"),
  rel("d-sync-db", "t-sqlite", "DECIDED", 4, "Sync driver"),
  rel("p-asynciter", "m-gitreader", "EXHIBITS", 9, "Streams commits"),
  rel("p-asynciter", "m-extractor", "EXHIBITS", 7, "Streams extraction"),
  rel("p-lazyimport", "m-llm-client", "EXHIBITS", 6, "Dynamic imports"),
  rel("p-xmlout", "m-extractor", "EXHIBITS", 11, "XML extraction prompts"),
  rel("p-xmlout", "t-fastxml", "EXHIBITS", 4, "Parser"),

  // Co-change clusters
  rel("m-extractor", "m-summarizer", "CO_CHANGED", 9, "Updated together"),
  rel("m-mcp-tools", "m-mcp-resources", "CO_CHANGED", 7, "Tooling pairs"),
  rel("m-llm-anthropic", "m-llm-openai", "CO_CHANGED", 6, "Provider parity"),
  rel("m-llm-openai", "m-llm-google", "CO_CHANGED", 5, "Provider parity"),
  rel("m-viz-app", "m-viz-server", "CO_CHANGED", 8, "Frontend ↔ backend"),
];

// ================================================================
// Helpers
// ================================================================

function mkEntity(
  id: string,
  type: string,
  name: string,
  description: string,
  community: string,
  frequency: number,
  aliases: string[] = [],
): MockEntity {
  // Spread firstSeen across the past two years, lastSeen recent.
  const now = new Date("2026-04-20T12:00:00Z").getTime();
  const seedHash = hash(id);
  const firstOffsetDays = 60 + (seedHash % 600); // 2 months → ~2 years ago
  const lastOffsetDays = seedHash % 30; // 0–30 days ago
  return {
    id,
    type,
    name,
    description,
    aliases,
    frequency,
    firstSeen: new Date(now - firstOffsetDays * 86_400_000).toISOString(),
    lastSeen: new Date(now - lastOffsetDays * 86_400_000).toISOString(),
    community,
  };
}

function rel(
  source: string,
  target: string,
  type: string,
  weight: number,
  description: string,
): MockRelation {
  return { source, target, type, weight, description };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ================================================================
// Layout — runs ForceAtlas2 over the mock graph for realistic spread
// ================================================================

function computeMockLayout(): Map<string, { x: number; y: number }> {
  const graph = new UndirectedGraph();

  for (const e of ALL_ENTITIES) {
    const h = hash(e.id);
    graph.addNode(e.id, {
      x: ((h & 0xffff) / 0xffff) * 100 - 50,
      y: (((h >> 16) & 0xffff) / 0xffff) * 100 - 50,
    });
  }

  for (const r of RELATIONS) {
    if (!graph.hasNode(r.source) || !graph.hasNode(r.target)) continue;
    if (r.source === r.target) continue;
    const logWeight = 1 + Math.log(r.weight + 1);
    if (graph.hasEdge(r.source, r.target)) {
      const key = graph.edge(r.source, r.target)!;
      const w = graph.getEdgeAttribute(key, "weight") as number;
      graph.setEdgeAttribute(key, "weight", w + logWeight);
    } else {
      graph.addEdge(r.source, r.target, { weight: logWeight });
    }
  }

  forceAtlas2.assign(graph, {
    iterations: 1000,
    settings: {
      gravity: 0.08,
      scalingRatio: 50,
      slowDown: 8,
      linLogMode: true,
      barnesHutOptimize: false,
    },
  });

  const positions = new Map<string, { x: number; y: number }>();
  graph.forEachNode((node: string, attrs: Record<string, unknown>) => {
    positions.set(node, { x: attrs.x as number, y: attrs.y as number });
  });
  return positions;
}

// ================================================================
// Cached responses (computed once)
// ================================================================

let cachedGraph: GraphResponse | null = null;
let cachedStats: StatsResponse | null = null;

function buildGraph(): GraphResponse {
  if (cachedGraph) return cachedGraph;

  const positions = computeMockLayout();

  const communities: GraphCommunity[] = MOCK_COMMUNITIES.map((c, i) => ({
    id: c.id,
    title: c.title,
    summary: c.summary,
    color: COMMUNITY_COLORS[i % COMMUNITY_COLORS.length],
  }));

  const nodes: GraphNode[] = ALL_ENTITIES.map((e) => {
    const pos = positions.get(e.id) ?? { x: 0, y: 0 };
    return {
      id: e.id,
      type: e.type,
      name: e.name,
      description: e.description,
      frequency: e.frequency,
      lastSeen: e.lastSeen,
      communityId: e.community,
      x: pos.x,
      y: pos.y,
    };
  });

  // Dedup by undirected pair, keep highest weight
  const edgeMap = new Map<string, GraphEdge>();
  RELATIONS.forEach((r, idx) => {
    const key = [r.source, r.target].sort().join("\0");
    const existing = edgeMap.get(key);
    if (!existing || r.weight > existing.weight) {
      edgeMap.set(key, {
        id: `r-${idx}`,
        source: r.source,
        target: r.target,
        type: r.type,
        weight: r.weight,
        description: r.description,
      });
    }
  });

  cachedGraph = { nodes, edges: Array.from(edgeMap.values()), communities };
  return cachedGraph;
}

function buildStats(): StatsResponse {
  if (cachedStats) return cachedStats;
  const graph = buildGraph();
  cachedStats = {
    entities: graph.nodes.length,
    relations: graph.edges.length,
    communities: graph.communities.length,
    commits: 1247,
    lastIndexedAt: new Date("2026-04-25T09:30:00Z").toISOString(),
  };
  return cachedStats;
}

// ================================================================
// Detail responses
// ================================================================

const COMMIT_AUTHORS = ["Alice Chen", "Bob Martinez", "Clara Liu", "David Park", "Eli Singh"];
const COMMIT_PREFIXES = [
  "feat: ",
  "fix: ",
  "refactor: ",
  "test: ",
  "docs: ",
  "chore: ",
];
const COMMIT_TOPICS = [
  "tighten extractor prompt for cross-cluster bridges",
  "wire community color into sigma reducer",
  "stop forceAtlas2 from melting clusters into the center",
  "add fixture repo for end-to-end indexing test",
  "split llm client into per-provider adapters",
  "FTS5 trigger for entity upserts",
  "graceful fallback when no API key is detected",
  "drop ssh remote — unused since v0.2",
  "switch to async iterators for git log streaming",
  "deduplicate edges by undirected pair",
];

function buildEntityDetail(id: string): EntityDetailResponse | null {
  const entity = ALL_ENTITIES.find((e) => e.id === id);
  if (!entity) return null;

  const myRels = RELATIONS.filter((r) => r.source === id || r.target === id);

  const annotated: EntityDetailRelation[] = myRels.map((r, idx) => {
    const isOutgoing = r.source === id;
    const otherId = isOutgoing ? r.target : r.source;
    const other = ALL_ENTITIES.find((e) => e.id === otherId);
    return {
      id: `r-${id}-${idx}`,
      type: r.type,
      targetId: otherId,
      targetName: other?.name ?? otherId,
      targetType: other?.type ?? "UNKNOWN",
      weight: r.weight,
      description: r.description,
      direction: isOutgoing ? "outgoing" : "incoming",
    };
  });
  annotated.sort((a, b) => b.weight - a.weight);

  const community = MOCK_COMMUNITIES.find((c) => c.id === entity.community);

  // Synthesize plausible recent commits
  const commitCount = Math.min(8, Math.max(2, Math.floor(entity.frequency / 8)));
  const recentCommits = Array.from({ length: commitCount }, (_, i) => {
    const seed = hash(id + i);
    const prefix = COMMIT_PREFIXES[seed % COMMIT_PREFIXES.length];
    const topic = COMMIT_TOPICS[(seed >> 3) % COMMIT_TOPICS.length];
    const author = COMMIT_AUTHORS[(seed >> 6) % COMMIT_AUTHORS.length];
    const daysAgo = i * 3 + (seed % 4);
    const date = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    return {
      hash: (seed.toString(16) + "0000000").slice(0, 7),
      message: prefix + topic,
      date,
      authorName: author,
    };
  });

  return {
    entity: {
      id: entity.id,
      type: entity.type,
      name: entity.name,
      description: entity.description,
      aliases: entity.aliases,
      frequency: entity.frequency,
      firstSeen: entity.firstSeen,
      lastSeen: entity.lastSeen,
    },
    relations: annotated,
    communities: community
      ? [{ id: community.id, title: community.title, summary: community.summary }]
      : [],
    recentCommits,
  };
}

function buildCommunityDetail(id: string): CommunityDetailResponse | null {
  const community = MOCK_COMMUNITIES.find((c) => c.id === id);
  if (!community) return null;

  const members = ALL_ENTITIES.filter((e) => e.community === id);
  members.sort((a, b) => {
    if (b.frequency !== a.frequency) return b.frequency - a.frequency;
    return a.name.localeCompare(b.name);
  });

  return {
    id: community.id,
    title: community.title,
    summary: community.summary,
    topEntities: members.slice(0, 5).map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      frequency: e.frequency,
    })),
  };
}

// ================================================================
// Provider
// ================================================================

export function createMockProvider(): VizDataProvider {
  return {
    getGraph: () => buildGraph(),
    getStats: () => buildStats(),
    getEntity: (id: string) => buildEntityDetail(id),
    getCommunity: (id: string) => buildCommunityDetail(id),
    close: () => {
      // no-op
    },
  };
}
