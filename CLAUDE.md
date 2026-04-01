# CLAUDE.md — Git Oracle

## What is this project?

Git Oracle is a GraphRAG-powered knowledge graph for git repositories. It extracts entities (people, modules, technologies, decisions, patterns) and relationships from git commit history, builds a community-structured knowledge graph, and exposes it via MCP tools that integrate with AI coding agents across 5 platforms: Claude Code, Cursor, OpenCode, Codex, and Gemini CLI.

**Two-mode token strategy:**
- **Querying = zero extra cost.** MCP tools return structured graph data from SQLite. The host agent synthesizes the narrative using its own tokens — like Superpowers.
- **Indexing = provider-agnostic batch LLM calls.** Auto-detects available API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`) and uses whichever is available. Falls back to agent-mediated mode if no key is found.

## Repository Structure

This is a TypeScript monorepo. All source code is in `src/`.

### Platform Shims (one per supported agent)
- `.claude-plugin/` — Claude Code plugin manifest
- `.cursor-plugin/` — Cursor plugin manifest
- `.codex/INSTALL.md` — Codex install instructions (agent reads and follows these)
- `.opencode/plugins/git-oracle.js` — OpenCode JS plugin hook
- `gemini-extension.json` + `GEMINI.md` — Gemini CLI support
- `.mcp.json` — MCP server config (shared by Claude Code + Cursor)
- `hooks/session-start.sh` — Cross-platform bootstrap (detects platform, injects skills)

### Core Source
- `src/pipeline/` — Indexing pipeline (git reader → chunker → extractor → resolver → graph builder → clusterer → summarizer)
- `src/store/` — SQLite storage layer (better-sqlite3, FTS5)
- `src/query/` — Query engine (local search, global search, graph operations)
- `src/mcp/` — MCP server (tools, resources, server setup)
- `src/llm/` — Provider-agnostic LLM client (Anthropic, OpenAI, Google)
- `src/shared/` — Types, config, logger
- `src/cli.ts` — CLI entry point (`npx git-oracle index`, `npx git-oracle query`)
- `src/index.ts` — MCP server entry point

### Other
- `skills/` — Agent skills (SKILL.md files, shared across all platforms)
- `docs/` — Architecture docs (ARCHITECTURE.md, PRD.md, PROMPTS.md)

## Architecture Docs

Read these docs for full context before implementing:

1. **docs/PRD.md** — Product requirements, phased roadmap, success metrics
2. **docs/ARCHITECTURE.md** — Full technical spec with data models, module interfaces, schema, multi-platform shims, provider-agnostic LLM client, and 30-step implementation order
3. **docs/PROMPTS.md** — LLM prompts for entity extraction and community summarization, with few-shot examples and XML parsing guidance

## Implementation Order

Follow the 30-step implementation order in ARCHITECTURE.md § "Implementation Order". Each step should be implemented, tested (with vitest), and committed before the next.

## Key Technical Decisions

- **TypeScript only** — Single runtime (Node.js), natural for the plugin ecosystem.
- **Multi-platform** — Follows the Superpowers pattern: one set of skills + one MCP server + platform-specific shims for Claude Code, Cursor, OpenCode, Codex, and Gemini CLI.
- **Provider-agnostic LLM** — Auto-detects API keys from environment. Supports Anthropic (Claude), OpenAI (GPT + compatible endpoints like Ollama/OpenRouter), and Google (Gemini). Same prompts work across all providers.
- **SQLite + FTS5** — Zero infrastructure. Database lives in `.git-oracle/oracle.db`.
- **better-sqlite3** — Synchronous SQLite driver. Fast, no native build issues.
- **graphology** — Pure JS graph library for Louvain community detection.
- **simple-git** — Git operations wrapper. Streams commits via async iterators.
- **@modelcontextprotocol/sdk** — MCP server implementation.
- **fast-xml-parser** — Parse structured XML output from LLM extraction.
- **tsup** — Bundle for distribution.
- **vitest** — Test framework.

## LLM Provider Details

| Provider | SDK | Env Var | Default Model | When Used |
|----------|-----|---------|---------------|-----------|
| Anthropic | `@anthropic-ai/sdk` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` | Claude Code users |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4.1-mini` | Codex/Cursor users |
| Google | `@google/genai` | `GOOGLE_API_KEY` / `GEMINI_API_KEY` | `gemini-2.5-flash` | Gemini CLI users |

All SDKs are lazy-imported — only the detected provider's SDK loads at runtime.

For custom endpoints (Ollama, OpenRouter, Azure), set `GIT_ORACLE_BASE_URL` alongside the appropriate API key.

## Testing Strategy

- Unit tests for each pipeline module with fixture data (no LLM calls).
- Integration tests for extractor and summarizer that make real API calls (skip in CI without API key).
- Fixture repo: Create a small git repo in `tests/fixtures/sample-repo/` with ~20 meaningful commits for end-to-end testing.
- Test the MCP server using the MCP inspector tool.
- Test platform shims by verifying plugin.json structure and hook output format.

## Conventions

- Use strict TypeScript (`strict: true`).
- Prefer `async/await` over callbacks.
- Use `AsyncIterable` for streaming large datasets (commits, extraction results).
- All database operations are synchronous (better-sqlite3's design).
- Log with structured logger (`src/shared/logger.ts`) — never bare `console.log`.
- Error handling: Pipeline steps should be resilient. Log and skip malformed data rather than crashing.
- Naming: `camelCase` for variables/functions, `PascalCase` for types/interfaces, `UPPER_SNAKE` for enums.
- Platform detection: Use env vars (`CLAUDE_PLUGIN_ROOT`, `CURSOR_PLUGIN_ROOT`, `OPENAI_API_KEY`, etc.) — never hardcode platform assumptions.

## Common Commands

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Index current repo
npx git-oracle index

# Index with options
npx git-oracle index --max-commits 1000 --since 2024-01-01 --provider openai

# Query (CLI mode, for testing)
npx git-oracle query "who knows the billing module best?"

# Check index status
npx git-oracle stats

# Start MCP server (for manual testing)
npx git-oracle serve

# Run MCP inspector
npx @modelcontextprotocol/inspector node dist/index.js
```

## LLM Cost Model

- **Indexing:** ~500 tokens per TextUnit extraction, ~300 tokens per community summary.
- **Querying:** Zero LLM cost — tools return structured data, the host agent synthesizes.
- **Cost per 1k commits (approximate):**
  - Anthropic (Claude Sonnet): ~$0.50-$1.00
  - OpenAI (GPT-4.1-mini): ~$0.30-$0.60
  - Google (Gemini Flash): ~$0.10-$0.30
  - Ollama (local): $0.00

## Git Workflow

- Feature branches off `main`.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- Each implementation step = one or more commits.
