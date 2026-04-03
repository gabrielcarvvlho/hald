---
name: git-oracle-query
description: Use when the user asks about code ownership or expertise ("who knows...", "who should review..."), architectural decisions ("why did we...", "what was the reason for..."), code history or evolution ("how did ... evolve", "history of..."), module coupling or dependencies ("what depends on...", "what changes together..."), knowledge silos or bus factor ("who's the only person who knows...", "what if X leaves"), entity relationships ("how is X connected to Y"), or codebase overview ("tell me about the architecture", "what are the main components"). Use for any question that requires understanding the repository's history beyond what's in the current code.
---

# Git Oracle Query

## Before You Query

Call `git_oracle_stats` to check if the index exists. If the tool returns an error containing "no such table", "unable to open", or "No index found", the repo hasn't been indexed yet — tell the user and suggest running `git_oracle_index` (see the git-oracle-index skill).

## MCP Tools

### `git_oracle_query`
For free-form questions. Pass the user's question and let the tool decide between local search (entity-centric) and global search (thematic). The tool returns structured graph data — **you synthesize the narrative**.

### `git_oracle_find_expert`
For "who knows X" questions. Pass the module/file path. Returns ranked experts with commit counts, recency, and breadth.

### `git_oracle_trace_decision`
For "why did we..." questions. Pass the topic. Returns a timeline of commits, people involved, and extracted decision context.

### `git_oracle_show_coupling`
For dependency and coupling questions. Pass the module path. Returns co-change data showing what modules tend to change together and their blast radius.

### `git_oracle_get_entity`
For looking up a specific person, module, technology, or decision. Pass an entity ID (e.g., `person:alice-chen`), exact name (e.g., `Alice Chen`), or a search term. Returns full details: type, description, aliases, activity timeline, and relationships.

### `git_oracle_get_path`
For "how is X connected to Y" questions. Pass two entity names or IDs. Returns the shortest relationship path through the knowledge graph — showing how people, modules, technologies, and decisions are connected via authorship, usage, and co-change edges.

### `git_oracle_find_silos`
For bus factor and knowledge risk questions. Returns modules with only one active maintainer (bus factor = 1) and orphaned modules (no active maintainer). Useful for team planning, onboarding priorities, and risk assessment.

### `git_oracle_stats`
Check if the index exists and how fresh it is. Call this first if you're unsure whether the repo has been indexed.

## Response Pattern

1. **Check index first.** If unsure whether the repo is indexed, call `git_oracle_stats`. If the index doesn't exist or is empty, suggest `git_oracle_index` before proceeding.
2. **Choose the right tool.** Match the question type:
   - Who knows X? → `git_oracle_find_expert`
   - Why did we...? → `git_oracle_trace_decision`
   - What changes with X? → `git_oracle_show_coupling`
   - What's our bus factor? → `git_oracle_find_silos`
   - How is X connected to Y? → `git_oracle_get_path`
   - Tell me about entity X → `git_oracle_get_entity`
   - Everything else → `git_oracle_query`
3. **Synthesize, don't dump.** The tools return structured data (entities, relations, community summaries, text units). Weave this into a clear, actionable narrative. Don't just list the raw data.
4. **Cite evidence.** When the tool returns specific commits or text units, reference them naturally (e.g., "Based on commits from March 2024, Alice led the migration...").
5. **Acknowledge gaps.** If the graph doesn't have enough data, say so. Suggest additional indexing or narrower queries.

## Examples

**User:** "Who should review changes to the billing module?"
**You:** Call `git_oracle_find_expert` with module `src/billing`. Synthesize: who knows the code, how recently active, which specific areas they've touched.

**User:** "Why did we switch from Webpack to Vite?"
**You:** Call `git_oracle_trace_decision` with topic "Webpack to Vite migration". Synthesize the timeline: who drove it, when, and what commits reveal about the motivation.

**User:** "Give me an overview of the codebase architecture"
**You:** Call `git_oracle_query` with the question (global search over community summaries). Synthesize the top communities into an architecture overview.

**User:** "What's the bus factor for our payment system?"
**You:** Call `git_oracle_find_silos`. Filter results for payment-related modules. Report which modules have single maintainers and who they are.

**User:** "How is Alice connected to the auth module?"
**You:** Call `git_oracle_get_path` with from "Alice" and to "auth". Walk through the path: Alice authored module X, which co-changes with auth.

**User:** "Tell me everything about the database layer"
**You:** Call `git_oracle_get_entity` with query "database layer". Report its type, description, relationships, and activity timeline.
