# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Deterministic git-authorship ownership layer — `hald_find_expert` and silo
  detection now blend extracted entities with ground-truth authorship from git,
  so ownership answers no longer depend solely on LLM extraction.
- Documented the Zhipu AI provider (`ZHIPU_API_KEY`, default `glm-4-flash`) as a
  first-class, lowest-cost indexing option across the README, CLAUDE.md, and the
  agent install docs.
- CHANGELOG.md (this file).

### Fixed

- Locale-independent number formatting in CLI output (no more `1.234` vs `1,234`
  drift across locales).
- Graceful FTS fallback when a query embedding's dimensionality no longer matches
  the stored index, instead of failing the search.
- Deduplicate gleaned relations and stop sibling-module over-merging in the
  entity resolver.
- Idempotent store `clear()`, locale-safe relation dates, a `NOCASE` index, and a
  WAL-safe database rename.

### Changed

- Renamed the on-disk database from `.hald/oracle.db` to `.hald/hald.db`, with a
  one-time automatic migration on first open (the last place "oracle" appeared in
  user-visible state).
- Default Anthropic model refreshed to `claude-sonnet-4-6` (from the May 2025
  vintage default).
- Scoped the CommonJS ESLint rules to `.opencode/plugins/` so the OpenCode plugin
  lints cleanly without relaxing rules project-wide.
- Repo hygiene: gitignore `.superset/`, `.git-oracle/`, and `haldy-*.tgz`.
- Documentation accuracy pass for the public release: working install snippets for
  every platform (Gemini extension now registers the MCP server; Claude Code leads
  with the `npx haldy serve` `.mcp.json` snippet), refreshed model names, synced
  plugin manifest versions, and a pruned TODOS list.

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

[Unreleased]: https://github.com/gabrielcarvvlho/hald/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/gabrielcarvvlho/hald/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/gabrielcarvvlho/hald/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/gabrielcarvvlho/hald/releases/tag/v0.1.0
