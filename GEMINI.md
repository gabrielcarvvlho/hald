# Git Oracle — Gemini CLI Integration

Git Oracle provides MCP tools for querying your repository's knowledge graph. The tools are available via the MCP server.

## Tool Name Mappings

Gemini CLI uses different tool names than Claude Code. Here are the equivalents:

| Gemini CLI Tool | Claude Code Equivalent |
|----------------|------------------------|
| `read_file` | `Read` |
| `write_file` | `Write` |
| `run_terminal_cmd` | `Bash` |
| `search_files` | `Grep` |
| `list_files` | `Glob` |

## Available Git Oracle MCP Tools

These tools are provided via the MCP server and work the same across all platforms:

### Query tools
- **git_oracle_query** — Free-form question about the repo (auto-routes between local/global search)
- **git_oracle_find_expert** — Find who knows a module best (ranked by authorship × recency)
- **git_oracle_trace_decision** — Trace an architectural decision through commit history
- **git_oracle_show_coupling** — Show module co-change patterns and blast radius
- **git_oracle_get_path** — Find shortest relationship path between two entities (people, modules, tech)
- **git_oracle_get_entity** — Look up a specific entity by ID, name, or fuzzy search
- **git_oracle_find_silos** — Identify knowledge risk areas (bus factor ≤ 1, orphaned modules)
- **git_oracle_stats** — Check index status (exists? how fresh? entity/relation counts)

### Indexing tools
- **git_oracle_index** — Build or refresh the knowledge graph (incremental by default)

### Agent-mediated extraction (used when no API key is available)
- **git_oracle_extract_next** — Get next chunk for agent-mediated entity extraction
- **git_oracle_submit_extraction** — Submit XML extraction result for current chunk
- **git_oracle_finalize_index** — Finalize agent-mediated session (runs resolution + graph building)

## Setup

1. Install: `npm install && npm run build`
2. The MCP server is configured in `gemini-extension.json`.
3. The skills in `skills/` directory teach the agent when and how to use each tool.

## Environment Variables

For indexing, set at least one LLM API key:
- `ANTHROPIC_API_KEY` — Claude (default)
- `OPENAI_API_KEY` — GPT-4.1 / compatible endpoints
- `GOOGLE_API_KEY` or `GEMINI_API_KEY` — Gemini
- `GIT_ORACLE_BASE_URL` — Custom endpoints (Ollama, OpenRouter)

If no key is set, indexing falls back to agent-mediated mode (zero cost, the agent performs extraction itself).
