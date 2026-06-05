# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-06-05

A public-launch polish sweep: a deterministic ownership layer, a full graph-viewer
polish pass, data-correctness fixes, and a documentation accuracy pass.

### Added

- **Deterministic git-authorship ownership layer** — `hald_find_expert` and silo
  detection now blend extracted entities with ground-truth authorship from git
  (PERSON entities and AUTHORED/MODIFIED edges from commit author + changed files),
  so "who knows module X?" no longer depends solely on LLM extraction.
- **Graph-viewer polish**: a legend decoding the visual encoding (color/size/edge/
  chips), a shortcuts popover and a one-time discoverability hint, a responsive
  layout (sidebar collapses to a bottom sheet on small screens), `:focus-visible`
  rings and a `prefers-reduced-motion` pass, a top-N node/edge cap with a
  "showing top N of M" badge for large graphs, and a WebGL-aware engine error.
- **README hero** — a recording of the live graph viewer (communities,
  click-to-explain, dark mode), plus a reproducible capture pipeline.
- Documented the Zhipu AI provider (`ZHIPU_API_KEY`, default `glm-4-flash`) as a
  first-class, lowest-cost indexing option across the README, CLAUDE.md, and the
  agent install docs.
- First MCP-layer test coverage and `tests/viz/` unit tests for the extracted pure
  helpers; the viz browser modules are now linted. CHANGELOG.md (this file).

### Fixed

- `hald scan --full` is now idempotent — it clears the graph before rebuilding
  instead of doubling entity frequencies and relation weights on every re-run.
- Incremental scans no longer wipe LLM entity descriptions when the ownership layer
  re-touches an entity; ownership edges survive author name drift.
- `--max-commits N` indexes the oldest N commits and backfills the rest on later
  scans, instead of indexing the newest N and stranding history.
- A fresh repository with no commits prints a friendly message instead of crashing;
  `hald scan` with no API key exits early with guidance instead of mis-pricing.
- Semantic relations now carry real first/last-seen dates; locale-independent number
  formatting in CLI output; graceful FTS fallback on an embedding-dimension mismatch;
  deduplicated gleaned relations and no more sibling-module over-merge; idempotent
  store `clear()`, a `NOCASE` index, and a WAL-safe database rename.
- Viz server fails clearly when no port is free and opens the browser via `execFile`
  (no shell); `hald ask` no longer leaks the SQLite handle on failure; `hald_get_entity`
  output is bounded; the agent-mediated extraction loop can no longer livelock.

### Changed

- Split the 2138-line viz `app.js` into 21 native ES modules with a thin orchestrator.
- Renamed the on-disk database from `.hald/oracle.db` to `.hald/hald.db` (one-time
  automatic migration), refreshed the default Anthropic model to `claude-sonnet-4-6`,
  scoped the CommonJS ESLint rules to `.opencode/plugins/`, and ran a documentation
  accuracy pass: working install snippets for every platform (Gemini extension now
  registers the MCP server; Claude Code leads with the `npx haldy serve` `.mcp.json`
  snippet), refreshed model names and cost labels, synced plugin manifest versions,
  and a pruned TODOS list.

## [0.2.1] - 2026-06

### Fixed

- CLI now reads its version from `package.json` to prevent version drift between
  the published package and the `--version` output.

### Changed

- Normalized `repository.url` with the `git+` prefix to satisfy npm packaging.

## [0.2.0] - 2026-06

### Added

- **Interactive graph visualizer** (`hald graph`) — an offline, dependency-free
  browser view of the knowledge graph: floating community labels with LLM-summary
  tooltips and click-to-explain detail cards, schema-driven type-filter chips,
  hull-anchored labels with zoom-driven density, curved (Bezier) edges with
  weight-mapped thickness and alpha, atmospheric background, focus halo, breathing
  motion with hover ripple (honoring `prefers-reduced-motion`), Cmd/Ctrl-click
  shortest-path highlighting with semantic edge labels, dark mode with system
  preference and persistence, keyboard shortcuts, shareable URL state, top-expert
  labels on first paint, and PNG export.
- `hald graph --mock` — a built-in fixture graph for visual iteration with zero
  index and zero LLM cost.
- Pretty TTY output for `hald scan` via a Presenter pattern (listr2 + ora), with
  `hald stats` polished to match the scan summary card style.

### Fixed

- Use `max_completion_tokens` for the OpenAI client.
- Correct viz vendor directory layout and robust `PUBLIC_DIR` detection.

## [0.1.0]

- Initial release: GraphRAG indexing pipeline (git reader → chunker → extractor →
  resolver → graph builder → Louvain clusterer → summarizer), SQLite + FTS5 store,
  local/global query engine, provider-agnostic LLM client (Anthropic, OpenAI,
  Google, Zhipu), MCP server with `hald_*` tools, and platform shims for Claude
  Code, Cursor, OpenCode, Codex, and Gemini CLI.

[Unreleased]: https://github.com/gabrielcarvvlho/hald/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/gabrielcarvvlho/hald/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/gabrielcarvvlho/hald/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/gabrielcarvvlho/hald/compare/fd4dbf7e84531573332053b929625973dc703fad...v0.2.0
[0.1.0]: https://github.com/gabrielcarvvlho/hald/commit/fd4dbf7e84531573332053b929625973dc703fad
