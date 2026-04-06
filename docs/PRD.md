# Git Oracle — Product Requirements Document

## Vision

Git Oracle turns a repository's git history into a queryable knowledge graph, surfacing institutional knowledge that would otherwise be lost to team turnover, Slack entropy, and undocumented decisions. It runs as a Claude Code plugin (with standalone MCP server fallback) and piggybacks on the user's existing LLM credits — no separate infrastructure, no SaaS subscription.

## Problem

Engineering teams lose institutional knowledge constantly:

- **"Why did we migrate from X to Y?"** — The decision is buried in a 6-month-old PR description nobody remembers.
- **"Who should review changes to the billing module?"** — `git blame` shows the last editor, not the domain expert who designed the system.
- **"Which modules are tightly coupled?"** — File co-change patterns reveal architecture that no diagram captures.
- **"What was the context for this weird code?"** — The commit message says "fix bug" but the surrounding commits tell the whole story.

Current tools (git blame, GitHub search, grep) answer point queries. They can't synthesize across hundreds of commits to answer structural or historical questions.

## Target User

Developers and engineering managers using AI coding assistants (Claude Code, Cursor, OpenCode) who work on codebases with meaningful git history (500+ commits). They already pay for LLM API access and want to get more value from it.

## Core Experience

```
Developer in Claude Code:
> "Why did we switch from REST to gRPC in the payments service?"

Claude (via Git Oracle MCP tools):
> Based on the git history, the migration happened across 3 PRs between
> March and May 2024, led by @alice and @bob. The key commits show...
> [synthesized narrative from community summaries and commit context]
```

The user never leaves their coding environment. The query is answered in seconds from pre-indexed local data, with the LLM synthesizing the final narrative.

## Phased Roadmap

### Phase 1 — Git-Only (MVP)

**Data sources:** git log, diffs, blame
**Entity types:** PERSON, MODULE, TECHNOLOGY, DECISION, PATTERN
**Relationship types:** AUTHORED, MODIFIED, CO_CHANGED, USES, DEPENDS_ON, INTRODUCED, REMOVED
**Query types:**
- `find_expert(module)` — Who knows this code best? (weighted by recency, frequency, breadth)
- `trace_decision(topic)` — When/why/who made this architectural choice?
- `show_coupling(module)` — What changes together with this module?
- `query_knowledge(question)` — Free-form question answered via GraphRAG local+global search

**Delivery:** Claude Code plugin + standalone MCP server
**Storage:** Local SQLite + FTS5, `.git-oracle/` directory in repo

### Phase 2 — GitHub Integration

**Additional data:** PRs (title, body, review comments), Issues (title, body, labels), Reviews (approvals, change requests)
**Additional entities:** ISSUE, PR, REVIEW
**Additional relationships:** CLOSES, REFERENCES, REVIEWED_BY, REQUESTED_BY
**New query types:**
- `find_context(file, line_range)` — What PR/issue/discussion led to this code?
- `review_history(person, module)` — What has this person reviewed in this area?

### Phase 3 — Multi-Source (Linear, Jira, Slack)

**Additional data:** Issue trackers, team communication
**Goal:** Complete institutional knowledge graph spanning code, project management, and communication.

## Non-Goals (v1)

- Real-time indexing (webhook-triggered) — batch is fine for v1
- Multi-repo graphs — single repo per index
- Web UI or dashboard — the interface IS the coding assistant
- Diff-level semantic analysis (understanding what code does) — we index commit metadata and file-level changes, not ASTs
- Supporting non-git VCS

## Technical Constraints

- **Zero infrastructure:** Everything runs locally. No Docker, no external DB, no cloud services.
- **Single runtime:** Node.js only. Users of Claude Code already have it.
- **LLM cost awareness:** Indexing a 5k-commit repo should cost < $5 in API calls. Querying costs nothing (pre-computed graph + host agent synthesis).
- **Incremental indexing:** Re-indexing after `git pull` should only process new commits.
- **Offline querying:** Once indexed, all queries work without network access (graph is local).

## Success Metrics

- **Installation to first query:** < 5 minutes (including indexing a small repo)
- **Index time:** < 2 minutes for 1k commits, < 15 minutes for 10k commits
- **Query latency:** < 500ms for graph lookup (LLM synthesis time is additional, controlled by host agent)
- **Index size:** < 50MB for a 10k-commit repo
- **Cost:** < $1 to index 1k commits, < $5 for 10k commits

## Competitive Landscape

| Tool | Approach | Limitation |
|------|----------|------------|
| `git blame` / `git log` | Point queries on raw history | No synthesis, no relationships |
| GitHub Copilot | Code completion, some repo context | No historical knowledge graph |
| Sourcegraph | Code search + intelligence | SaaS, no decision tracing, no community detection |
| Graphite / Gitstream | PR workflow optimization | No knowledge extraction |
| Microsoft GraphRAG | General-purpose document GraphRAG | Not designed for git data, heavy infrastructure |

Git Oracle's differentiator: **purpose-built GraphRAG for git history, delivered as a zero-infra plugin for AI coding assistants.**
