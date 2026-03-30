# Git Oracle — Gemini CLI Integration

Git Oracle provides MCP tools for querying your repository's knowledge graph. The tools are available via the MCP server.

## Tool Name Mappings

Gemini CLI uses different tool names than Claude Code. Here are the equivalents:

| Gemini CLI Tool | Equivalent |
|----------------|------------|
| `read_file` | `Read` |
| `write_file` | `Write` |
| `run_terminal_cmd` | `Bash` |
| `search_files` | `Grep` |
| `list_files` | `Glob` |

## Available Git Oracle Tools

These tools are provided via the MCP server and work the same across all platforms:

- **git_oracle_query** — Ask a free-form question about the repository
- **git_oracle_find_expert** — Find who knows a module best
- **git_oracle_trace_decision** — Trace an architectural decision
- **git_oracle_show_coupling** — Show module co-change patterns
- **git_oracle_index** — Index or re-index the repository
- **git_oracle_stats** — Check index status

## Setup

1. Install: `npm install && npm run build`
2. Start MCP server: `node dist/index.js`
3. The skills in `skills/` directory teach the agent when and how to use each tool.
