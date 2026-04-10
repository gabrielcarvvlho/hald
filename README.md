# hald

**Your codebase, held.**

GraphRAG-powered codebase intelligence. Builds a knowledge graph from your git history — commits, authors, files, relationships — and lets you query it with natural language. Like having a senior engineer who's read every commit and can answer any question about your codebase instantly.

<p align="center">
  <a href="https://www.npmjs.com/package/hald"><img src="https://img.shields.io/npm/v/hald?style=flat-square" alt="npm version"></a>
  <a href="https://github.com/gabrielcarvvlho/hald/actions"><img src="https://img.shields.io/github/actions/workflow/status/gabrielcarvvlho/hald/ci.yml?style=flat-square" alt="CI"></a>
  <a href="https://github.com/gabrielcarvvlho/hald/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License"></a>
</p>

## Quick Start

```bash
# Install
npm install -g hald

# Scan your repository (requires an LLM API key)
cd your-repo
hald scan

# Ask questions
hald ask "who knows the billing module best?"
hald ask "why did we migrate to gRPC?"
hald ask "what changed most in the last 3 months?"
hald stats
```

## How It Works

```
git log
   |
   v
 Chunker          (commits -> overlapping text units)
   |
   v
LLM Extraction    (entities: people, modules, decisions, patterns)
   |
   v
Entity Resolver   (deduplication + canonical names)
   |
   v
Knowledge Graph   (nodes + weighted edges in SQLite)
   |
   v
Community Detection  (Louvain clustering + LLM summaries)
   |
   v
MCP Tools         (hald_find_expert, hald_trace_decision, ...)
   |
   v
Your AI Agent     (synthesizes answers using its own tokens)
```

Scanning costs tokens. Querying is always free — tools return structured graph data and your agent does the reasoning.

## What You Can Ask

| Question type | Example | Tool used |
|---|---|---|
| Ownership | "Who knows the payments module best?" | `hald_find_expert` |
| Decisions | "Why did we switch from REST to gRPC?" | `hald_trace_decision` |
| Coupling | "What breaks when I touch the auth layer?" | `hald_show_coupling` |
| Silos | "Are there parts of the codebase nobody touches?" | `hald_find_silos` |
| Relationships | "How are the queue system and billing connected?" | `hald_get_path` |
| Free-form | "Summarize the architecture of the data pipeline" | `hald_query` |

## LLM Providers

hald auto-detects your available API key. Set one of these before running `hald scan`:

| Provider | Env Var | Default Model | Cost per 1k commits |
|---|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | claude-sonnet-4-20250514 | ~$0.50-$1.00 |
| OpenAI | `OPENAI_API_KEY` | gpt-4.1-mini | ~$0.30-$0.60 |
| Google | `GOOGLE_API_KEY` | gemini-2.5-flash | ~$0.10-$0.30 |
| Ollama (local) | `OPENAI_API_KEY` + `HALD_BASE_URL` | configurable | $0.00 |

Querying is always free — no LLM calls at query time.

## Platform Setup

### Claude Code

```bash
claude plugin add hald
```

Or add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "hald": {
      "command": "npx",
      "args": ["hald", "serve"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "hald": {
      "command": "npx",
      "args": ["hald", "serve"],
      "env": {
        "ANTHROPIC_API_KEY": "${env:ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

### Codex

See [`.codex/INSTALL.md`](.codex/INSTALL.md) for setup instructions.

### OpenCode

Copy `.opencode/plugins/hald.js` to your OpenCode plugins directory.

### Gemini CLI

```bash
cp gemini-extension.json ~/.gemini/extensions/hald.json
```

## CLI Reference

```
hald scan [options]            Build or update the knowledge graph
  --full                       Force full re-scan (ignore existing index)
  --max-commits <n>            Limit number of commits to process
  --since <date>               Only scan commits after this date (YYYY-MM-DD)
  --provider <name>            LLM provider: anthropic | openai | google | auto
  -y, --yes                    Skip cost confirmation prompt

hald ask <question>            Ask a natural language question
  --type <type>                Search strategy: local | global | auto

hald stats                     Show index statistics

hald graph                     Open interactive graph visualization in browser

hald reset                     Delete the local index and start fresh

hald serve                     Start the MCP server on stdio
```

## Configuration

Configuration priority (first wins):

1. CLI flags / MCP tool parameters
2. `.hald/config.json` in repo root
3. Environment variables (`HALD_*`)
4. Defaults

| Env Var | Description | Default |
|---|---|---|
| `HALD_PROVIDER` | LLM provider for scanning | `auto` |
| `HALD_MODEL` | Override default model | provider default |
| `HALD_BASE_URL` | Custom endpoint (Ollama, OpenRouter, Azure) | -- |
| `HALD_MAX_COMMITS` | Max commits to scan | unlimited |

## Storage

Index lives in `.hald/` at the repo root. Add to `.gitignore`:

```
.hald/
```

Safe to delete — run `hald scan` again to rebuild.

## Development

```bash
git clone https://github.com/gabrielcarvvlho/hald.git
cd hald
npm install
npm run build
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT
