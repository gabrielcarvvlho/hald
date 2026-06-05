# TODOs

Deferred work captured during reviews. Each item should have enough context that someone picking it up cold understands the motivation, current state, and where to start.

## Viz follow-ups (deferred from feat/clusterer-hardening eng review, 2026-04-25)

### Live graph refresh in viz

**What:** Add a way to re-fetch `/api/graph` data without restarting `hald graph`.

**Why:** Today `src/viz/server.ts:45-46` pre-computes `graphData` at startup. If a user runs `hald scan` in another terminal to update the index, the running viz shows stale data until they kill the server and restart it.

**Pros:** Better UX during incremental indexing flows. Sets foundation for "watch mode."

**Cons:** Adds complexity (cache invalidation, optional websocket vs poll, UI affordance for "graph updated"). Not strictly needed for demo use case.

**Context:** Current architecture pre-computes once because it's cheap and the CLI command is single-shot. A simple refresh button calling `getGraphData(store)` again on the server side would work. Trickier: detecting that the index actually changed (would need a store version number or mtime check).

**Depends on / blocked by:** None. Can be done independently.

### Performance ceiling test for large graphs

**What:** Measure and document viz performance with 10k, 50k, and 100k entities. If it falls over, add LOD (level-of-detail) rendering or move layout to a Web Worker.

**Why:** `viz/api.ts:getGraphData()` loads ALL entities and relations synchronously. `computeLayout()` runs ForceAtlas2 with 200 iterations on the main thread. For large repos this could take seconds-to-minutes at startup.

**Pros:** Unblocks adoption for monorepos and long-history projects. Required if viz becomes primary interface (Approach B in design doc).

**Cons:** Premature optimization until someone hits the ceiling. No user has reported it.

**Context:** Test repos at scale: clone a 5-year-old repo with thousands of commits, scan it, run `hald graph`. Measure: time-to-first-paint, frame rate during interaction, memory footprint. Ceiling cutoff: if first paint > 5s, action required.

**Depends on / blocked by:** None. Could be a benchmark added to CI.

## Speculative surfaces — deferred until distribution signal validates demand

### TUI surface — deferred until distribution signal validates demand

**What:** Build a terminal-native interactive interface for browsing the knowledge graph (entities, communities, relations, commits) using OpenTUI (https://opentui.com/). "k9s for codebases" — list communities → drill into one → see entities → jump to git commits → inline LLM summaries.

**Why:** Hald's audience is terminal-native. SSH/remote-dev users can't open a browser. Asciinema casts of TUI tools (lazygit, k9s, htop) go viral and embed cleanly in HN/README/Twitter. OpenTUI is TS-native, Bun-friendly, and **already powers OpenCode** — one of Hald's supported platforms (`.opencode/plugins/hald.js`). Integration cost is low.

**Pros:** Second viral asset alongside the web viz GIF. Native to the audience. Reuses the existing query engine (CLI/MCP backend) — net-new code is the TUI surface, not the brain.

**Cons:** Three frontends to maintain on a solo project (CLI, web viz, TUI). Demand not yet validated — no user has asked for it. Splits attention from the viz polish + distribution sprint that's the current bet.

**Context:** Considered during /plan-ceo-review on 2026-04-26 in response to "faria sentido termos uma TUI?" (https://opentui.com/). Decision: defer. The reframe revealed the user's real pain was ugly `haldy scan` output (now shipped — listr2 presenter), not lack of an interactive surface. TUI remains a real Phase 2 candidate.

**Trigger condition for revisit:** After viz polish ships + 3-day distribution sprint (Show HN, awesome lists, outreach), watch ~2 weeks of signal. If users say "I want this in my terminal," "I work over SSH," or "make it asciinema-able" — TUI becomes Phase 2, scoped at ~3-5 days with OpenTUI. If users don't ask, log the learning ("audience uses browser fine") and skip.

**Scoped MVP if revisited:** Single-screen layout — left pane lists communities sorted by size, right pane shows community detail (LLM summary + top 5 entities), bottom pane shows recent commits touching the selected community. Keyboard nav: arrows + Enter + `/` for search. Reuses `localSearch`/`globalSearch` from `src/query/`. Entry point: `hald` with no args opens the TUI; existing subcommands unchanged.

**Depends on / blocked by:** Should NOT ship before viz polish + distribution sprint.

**Effort estimate:** M (3-5 days human, ~half-day with CC+gstack).

**Priority:** P3 — speculative until demand validated.

### Live scan dashboard with OpenTUI

**What:** Replace the listr2 sequential output with a real-estate-aware live dashboard during `haldy scan` — like `bun install` or `cargo build`. Persistent regions: pipeline progress table, cost burn meter, ETA, recent extraction samples scrolling at the bottom.

**Why:** The shipped listr2 presenter solves "ugly scan output" for free. A live dashboard turns the scan command itself into a viral asset — an asciinema cast of the dashboard becomes a second hero alongside the web viz GIF. This is where OpenTUI actually earns its keep (interactive layout, not just sequential output).

**Context:** Considered during /plan-ceo-review on 2026-04-26 alongside the TUI question. Recommendation was the listr2 presenter first (now shipped), the dashboard only if there's appetite for a second hero asset. Don't blow the focus on the viz polish sprint by chasing it prematurely.

**Depends on / blocked by:** Builds on the shipped Presenter interface — the dashboard would swap a new implementation into the existing presenter abstraction. Same TTY-detection infra applies.

**Effort estimate:** M (1-1.5 days human, ~1-2h with CC+gstack).

**Priority:** P3 — pursue only if the viz polish + distribution sprint clears and there's appetite for a second hero asset.
