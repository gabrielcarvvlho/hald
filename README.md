# hald

**Your codebase, held.**

GraphRAG-powered codebase intelligence. Builds a knowledge graph from your git history — commits, authors, files, relationships — and lets you query it with natural language. Like having a senior engineer who's read every commit and can answer any question about your codebase instantly.

<p align="center">
  <a href="https://www.npmjs.com/package/haldy"><img src="https://img.shields.io/npm/v/haldy?style=flat-square" alt="npm version"></a>
  <a href="https://github.com/gabrielcarvvlho/hald/actions"><img src="https://img.shields.io/github/actions/workflow/status/gabrielcarvvlho/hald/ci.yml?style=flat-square" alt="CI"></a>
  <a href="https://github.com/gabrielcarvvlho/hald/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License"></a>
</p>

<p align="center">
  <a href="docs/assets/hero.gif">
    <img src="docs/assets/hero.gif" alt="Hald viz: communities, summaries, click-to-explain" width="820">
  </a>
</p>

> Run `hald scan` once. Then `hald graph` opens an interactive view of your codebase as a knowledge graph — communities labeled with LLM-generated summaries, top experts highlighted, click any cluster to explain it.

## Quick Start

```bash
# Install
npm install -g haldy

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

## Visual Explorer

```bash
hald graph                # open the real index (default)
hald graph --mock         # open a built-in fixture graph for design iteration
```

Opens an interactive visualization in your browser. Built-in:

- **Atmospheric canvas** — subtle radial gradient gives clusters depth. Solid fallback for browsers without `radial-gradient`.
- **Communities labeled with LLM summaries** — each cluster's title floats above the topmost node in the cluster (not at the centroid, so it never sits on a node). Hover for the full summary, click to open a detail card with the top 5 entities.
- **Top experts surfaced by default** — the most-connected nodes are labeled on first paint so you have anchors immediately.
- **Weight-mapped edges** — thickness AND alpha scale with relation weight (log-mapped). Heavy connections feel heavy; cross-cluster bridges stay quiet. Edges render as quadratic Bezier curves on a 2D overlay below the WebGL canvas.
- **Focus halo on hover** — the active node gets a soft amber-to-community-color glow. Resting state stays clean (no donut overlap).
- **Breathing motion** — nodes drift gently around their layout positions via uncorrelated sine oscillators. Honors `prefers-reduced-motion: reduce`.
- **Hover ripple** — neighbors of the hovered node briefly pulse so the local neighborhood reads at a glance.
- **Cmd-click paths** — ⌘-click (mac) or Ctrl-click (linux/win) a second node while one is selected to trace the shortest path. The path lights up in amber with a floating banner showing the full hop list AND the relation type between each pair (`Alice ─authored→ src/extractor ─uses→ src/store`). Click any hop to navigate without losing the path. Esc / ✕ / click-empty-space to clear.
- **Zoom-driven label density** — zoom in past ~0.4× to see labels on everything, zoom out past 2× to drop down to community labels only.
- **Search and filter** — `/` focuses search, type chips toggle entity types on/off, `Esc` closes panels. "0 matches" shows inline at the top of the canvas.
- **Light + dark mode** — follows system preference, toggleable in the header. Hover label pill recolors per theme so it stays readable.
- **Shareable URLs** — selected node and active filters persist in the URL hash. Copy/paste to send a specific view.
- **PNG export** — one click to save the current view as an image. Captures the curved edge overlay and the live community labels.
- **Keyboard nav** — arrow keys pan, `/` searches, `Esc` closes / clears path / closes sidebar.
- **Mock mode** — `hald graph --mock` boots a hand-curated fixture graph (~50 entities, 6 communities) for visual iteration without re-indexing or any LLM cost.

Works fully offline — no CDN dependencies.

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
| Anthropic | `ANTHROPIC_API_KEY` | claude-sonnet-4-6 | ~$0.50-$1.00 |
| OpenAI | `OPENAI_API_KEY` | gpt-5.4-mini | ~$0.50-$1.00 |
| Google | `GOOGLE_API_KEY` | gemini-3.1-flash-lite-preview | ~$0.15-$0.40 |
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
      "args": ["haldy", "serve"]
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
      "args": ["haldy", "serve"],
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
  --mock                         Use a built-in fixture graph (no index required)
  --port <number>                HTTP server port (default 3742)
  --no-open                      Don't auto-open the browser

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
