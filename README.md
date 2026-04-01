# Git Oracle

GraphRAG-powered knowledge graph for git repositories. Extracts entities (people, modules, technologies, decisions, patterns) and relationships from your commit history, builds a community-structured knowledge graph, and exposes it via MCP tools for AI coding agents.

**Zero-cost querying** -- MCP tools return structured graph data from SQLite. Your AI agent synthesizes the narrative using its own tokens.

## Quick Start

```bash
# Install
npm install -g git-oracle

# Index your repository (requires an LLM API key)
cd your-repo
git-oracle index

# Query from CLI
git-oracle query "who knows the billing module best?"
git-oracle query "why did we migrate to gRPC?"
git-oracle stats
```

## How It Works

1. **Index** -- Reads your git history, chunks commits into text units, and uses an LLM to extract entities and relationships
2. **Build** -- Constructs a knowledge graph, detects communities via Louvain clustering, and generates community summaries
3. **Query** -- MCP tools search the graph (FTS5 + graph traversal) and return structured context to your AI agent

```
Git History --> Chunker --> LLM Extraction --> Knowledge Graph --> MCP Tools --> AI Agent
```

## LLM Providers

Git Oracle auto-detects your available API key. Set one of these:

| Provider | Env Var | Default Model | Cost per 1k commits |
|----------|---------|---------------|---------------------|
| Anthropic | `ANTHROPIC_API_KEY` | claude-sonnet-4-20250514 | ~$0.50-$1.00 |
| OpenAI | `OPENAI_API_KEY` | gpt-4.1-mini | ~$0.30-$0.60 |
| Google | `GOOGLE_API_KEY` | gemini-2.5-flash | ~$0.10-$0.30 |
| Ollama | `OPENAI_API_KEY` + `GIT_ORACLE_BASE_URL` | configurable | $0.00 |

## MCP Tools

Once indexed, these tools are available to your AI agent:

| Tool | Description |
|------|-------------|
| `git_oracle_query` | Free-form questions about history, architecture, decisions |
| `git_oracle_find_expert` | Find who knows a module/file best |
| `git_oracle_trace_decision` | Trace the history of a technical decision |
| `git_oracle_show_coupling` | Show modules that change together |
| `git_oracle_get_path` | Find relationship path between two entities |
| `git_oracle_get_entity` | Look up entity details by ID, name, or search |
| `git_oracle_index` | Index or re-index the repository |
| `git_oracle_stats` | Get index statistics |

## Platform Setup

### Claude Code

Install as a plugin -- Git Oracle auto-registers its MCP server and skills:

```bash
claude plugin add /path/to/git-oracle
```

### Cursor

Install as a plugin:

```bash
# Copy to your project or install globally
cp -r /path/to/git-oracle/.cursor-plugin .cursor-plugin
cp /path/to/git-oracle/.mcp.json .mcp.json
```

### Codex

See [`.codex/INSTALL.md`](.codex/INSTALL.md) for setup instructions.

### OpenCode

See [`.opencode/INSTALL.md`](.opencode/INSTALL.md) for setup instructions.

### Gemini CLI

Add to your Gemini extensions:

```bash
cp /path/to/git-oracle/gemini-extension.json ~/.gemini/extensions/git-oracle.json
```

## CLI Reference

```
git-oracle index [options]     Index the repository
  --full                       Force full re-index
  --max-commits <n>            Limit commits to process
  --since <date>               Only index commits after this date
  --provider <name>            LLM provider (anthropic|openai|google|auto)
  -y, --yes                    Skip cost confirmation

git-oracle query <question>    Query the knowledge graph
  --type <type>                Search type (local|global|auto)

git-oracle stats               Show index statistics

git-oracle serve               Start MCP server on stdio
```

## Configuration

Configuration is read in this order (first wins):

1. CLI flags / MCP tool parameters
2. `.git-oracle/config.json` in the repo root
3. Environment variables (`GIT_ORACLE_*`)
4. Defaults

| Env Var | Description | Default |
|---------|-------------|---------|
| `GIT_ORACLE_REPO` | Repository path | `.` |
| `GIT_ORACLE_BRANCH` | Branch to index | `main` |
| `GIT_ORACLE_MAX_COMMITS` | Max commits to index | `5000` |
| `GIT_ORACLE_PROVIDER` | LLM provider | `auto` |
| `GIT_ORACLE_BASE_URL` | Custom LLM endpoint | -- |

## Storage

The index is stored in `.git-oracle/oracle.db` (SQLite). Add `.git-oracle/` to your `.gitignore`.

## Development

```bash
npm install          # Install dependencies
npm run build        # Build with tsup
npm test             # Run tests
npm run dev          # Watch mode
```

## License

MIT
