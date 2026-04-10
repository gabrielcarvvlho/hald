---
name: hald-index
description: Use when the user asks to index, re-index, or set up Hald for their repository, when a query tool returns an error indicating no index exists, when the user asks about index status or freshness, or when they mention "hald" in the context of setup or configuration.
---

# Hald Index

## MCP Tools

### `hald_index`
Triggers indexing of the current repository. Parameters:
- `full`: Set to `true` to force a complete re-index. Default is incremental (only new commits).
- `max_commits`: Limit the number of commits to process. Useful for testing or cost control.
- `since_date`: Only index commits after this ISO date (e.g., "2024-01-01").

### `hald_stats`
Check the current index status — whether it exists, how many entities/relations it has, and which commit was last indexed.

## Guidance

### First-time indexing
- Suggest starting with `max_commits: 500` for a first pass to see results quickly and estimate cost.
- For large repos (10k+ commits), recommend using `since_date` to focus on recent history.
- Warn that indexing makes LLM API calls that consume API credits. Rough estimate: ~$0.50-$1.00 per 1,000 commits (Anthropic), ~$0.30-$0.60 (OpenAI), ~$0.10-$0.30 (Google), $0.00 (Ollama).

### Re-indexing
- After `git pull`, suggest running incremental indexing (default behavior — no `full: true` flag).
- If the user reports stale or incorrect results, suggest `full: true` to rebuild from scratch.

### Troubleshooting
- If indexing fails with an API key error, the user needs one of: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_API_KEY` in their environment.
- If indexing is slow, suggest reducing `max_commits` or increasing the date filter.
- The index lives in `.hald/` in the repo root. It can be deleted and rebuilt at any time.

## Example Interactions

**User:** "Set up hald for this repo"
**You:** First call `hald_stats` to check if an index already exists. If not, explain what indexing does (extracts knowledge from git history, costs ~$0.50-1.00 per 1k commits) and call `hald_index` with a reasonable default.

**User:** "Re-index the repo, something seems off"
**You:** Call `hald_index` with `full: true`. Explain that this rebuilds the entire knowledge graph from scratch.

**User:** "How fresh is the hald index?"
**You:** Call `hald_stats` and report the last indexed commit, entity/relation counts, and when it was last updated.
