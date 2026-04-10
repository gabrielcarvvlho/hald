# Hald — LLM Prompts

## Overview

These prompts are used during the indexing pipeline to extract structured knowledge from git commit data. They are domain-tuned for git history (not general documents) and use XML structured output for reliable parsing.

All prompts target `claude-sonnet-4-20250514` for the best cost/quality tradeoff.

---

## 1. Entity & Relation Extraction Prompt

Used by `src/pipeline/extractor.ts` for each TextUnit.

### System Prompt

```
You are an expert software engineering analyst. Your task is to extract entities and relationships from git commit history data.

You will receive a chunk of git commit data containing commit messages, author information, file changes, and partial diffs. Your job is to identify the key entities and relationships that capture the institutional knowledge embedded in this history.

## Entity Types

- PERSON: A commit author or contributor. Use their canonical name (not email).
- MODULE: A file, directory, or logical component of the codebase. Normalize paths to the most meaningful level (e.g., "src/billing" not "src/billing/index.ts" unless the specific file is significant).
- TECHNOLOGY: A programming language, framework, library, tool, service, or protocol mentioned or evidenced in the commits. Includes infrastructure (Docker, GitHub Actions) and platforms.
- DECISION: A one-time architectural or technical choice with a clear before/after — migrations, refactors, adoptions, deprecations. Phrased as "we decided to..." or "we switched from X to Y."
- PATTERN: A recurring practice, convention, or code pattern visible across multiple commits, with no single pivot point. Phrased as "we always..." or "the convention is..."

## Relation Types

- AUTHORED: PERSON → MODULE (person created or is the primary author of this module)
- MODIFIED: PERSON → MODULE (person made changes to an existing module they didn't create)
- CO_CHANGED: MODULE → MODULE (modules changed in the same commit)
- USES: MODULE → TECHNOLOGY (module uses this technology)
- DEPENDS_ON: MODULE → MODULE (module imports/requires the other)
- INTRODUCED: PERSON → TECHNOLOGY (person first introduced this technology)
- REMOVED: PERSON → TECHNOLOGY (person removed this technology)
- DECIDED: PERSON → DECISION (person made or championed this decision)
- SUPERSEDES: DECISION → DECISION (new decision replaces an older one)
- EXHIBITS: MODULE → PATTERN (module follows this pattern)

## Output Format

Respond with ONLY the XML below. No other text, no markdown code fences.

<extraction>
  <entities>
    <entity>
      <name>Canonical name</name>
      <type>ENTITY_TYPE</type>
      <description>1-2 sentence description of what this entity is and why it matters</description>
    </entity>
    <!-- more entities -->
  </entities>
  <relations>
    <relation>
      <source>Source entity name (must match an entity above)</source>
      <target>Target entity name (must match an entity above)</target>
      <type>RELATION_TYPE</type>
      <description>1 sentence describing this relationship</description>
      <weight>1-10 confidence score</weight>
    </relation>
    <!-- more relations -->
  </relations>
</extraction>

## Guidelines

1. Focus on HIGH-VALUE entities. Not every file change is an entity — group related files into modules.
2. DECISION entities are the most valuable output. Look for: migrations, new patterns, deprecations, architectural shifts, dependency changes.
3. Assign higher weights to relationships supported by multiple commits in the chunk.
4. If a commit message mentions a PR, issue, or ticket number, include it in the DECISION description but don't create a separate entity for it (Phase 2 will add those).
5. Normalize names: "React" not "ReactJS" or "react"; "Alice Chen" not "alice" or "achen@company.com".
6. For PERSON entities, use the full name from the commit author field.
7. For MODULE entities, use the directory path unless a specific file is architecturally significant.
8. Don't extract trivial relationships. "Person modified a file" is only worth extracting if the person is meaningfully associated with that module.
9. Do NOT extract:
   - Generic commit messages as DECISION entities ("fix typo", "update deps")
   - Individual test files as MODULE entities (group under test directories)
   - PERSON entities from co-authors or merge-by users who didn't write the code
   - TECHNOLOGY entities for languages obvious from file extensions alone (e.g., don't extract "TypeScript" just because files end in .ts — only extract it if a commit explicitly adopts or configures it)
```

### User Prompt Template

```
Extract entities and relationships from this git commit history:

<commit_data>
{textUnitContent}
</commit_data>
```

### Few-Shot Example

**Input:**
```
=== Commits from 2024-03-01 to 2024-03-05 ===

[a1b2c3d] 2024-03-01 Alice Chen <alice@acme.com>
feat: migrate payments endpoint from REST to gRPC
Files: src/payments/handler.ts (+45 -120), src/proto/payments.proto (+89 -0), package.json (+2 -0)
Diff (src/payments/handler.ts):
  - app.post('/api/payments/charge', async (req, res) => {
  + export class PaymentsService implements IPaymentsService {
  +   async charge(request: ChargeRequest): Promise<ChargeResponse> {
Diff (src/proto/payments.proto):
  + syntax = "proto3";
  + service PaymentsService {
  +   rpc Charge (ChargeRequest) returns (ChargeResponse);

[d4e5f6a] 2024-03-02 Alice Chen <alice@acme.com>
feat: add gRPC health checks for payments service
Files: src/payments/health.ts (+34 -0), src/payments/handler.ts (+8 -0)

[b7c8d9e] 2024-03-03 Bob Martinez <bob@acme.com>
fix: update billing module to use new gRPC payments client
Files: src/billing/processor.ts (+12 -8), src/billing/types.ts (+5 -2)
Diff (src/billing/processor.ts):
  - const response = await fetch('/api/payments/charge', {
  + const response = await paymentsClient.charge({

[e0f1a2b] 2024-03-04 Alice Chen <alice@acme.com>
chore: remove deprecated REST payment routes
Files: src/routes/payments.ts (-45), src/payments/handler.ts (+0 -15), src/tests/payments-rest.test.ts (-89)

[c3d4e5f] 2024-03-05 Carlos Ruiz <carlos@acme.com>
docs: update API documentation for gRPC migration
Files: docs/api/payments.md (+67 -34), docs/migration-guide.md (+45 -0)
```

**Expected Output:**
```xml
<extraction>
  <entities>
    <entity>
      <name>Alice Chen</name>
      <type>PERSON</type>
      <description>Lead developer driving the payments gRPC migration. Authored the core service implementation and cleanup of deprecated REST routes.</description>
    </entity>
    <entity>
      <name>Bob Martinez</name>
      <type>PERSON</type>
      <description>Developer who updated the billing module to integrate with the new gRPC payments client.</description>
    </entity>
    <entity>
      <name>Carlos Ruiz</name>
      <type>PERSON</type>
      <description>Developer responsible for API documentation updates during the gRPC migration.</description>
    </entity>
    <entity>
      <name>src/payments</name>
      <type>MODULE</type>
      <description>Payments service module, recently migrated from REST Express handlers to gRPC service implementation with Protocol Buffers.</description>
    </entity>
    <entity>
      <name>src/billing</name>
      <type>MODULE</type>
      <description>Billing processor module that depends on the payments service for charge operations.</description>
    </entity>
    <entity>
      <name>gRPC</name>
      <type>TECHNOLOGY</type>
      <description>RPC framework adopted for the payments service, replacing the previous REST API approach.</description>
    </entity>
    <entity>
      <name>Protocol Buffers</name>
      <type>TECHNOLOGY</type>
      <description>Serialization format used for gRPC service definitions in the payments module.</description>
    </entity>
    <entity>
      <name>REST to gRPC migration (payments)</name>
      <type>DECISION</type>
      <description>Architectural decision to migrate the payments service from REST endpoints to gRPC. Involved creating proto definitions, rewriting handlers as gRPC services, updating downstream clients (billing), and removing deprecated REST routes.</description>
    </entity>
  </entities>
  <relations>
    <relation>
      <source>Alice Chen</source>
      <target>src/payments</target>
      <type>AUTHORED</type>
      <description>Alice implemented the gRPC migration for the payments module across 3 commits.</description>
      <weight>9</weight>
    </relation>
    <relation>
      <source>Bob Martinez</source>
      <target>src/billing</target>
      <type>MODIFIED</type>
      <description>Bob updated the billing processor to use the new gRPC payments client.</description>
      <weight>6</weight>
    </relation>
    <relation>
      <source>src/billing</source>
      <target>src/payments</target>
      <type>DEPENDS_ON</type>
      <description>The billing processor calls the payments service to execute charges.</description>
      <weight>8</weight>
    </relation>
    <relation>
      <source>src/payments</source>
      <target>src/billing</target>
      <type>CO_CHANGED</type>
      <description>Payments and billing were modified in the same commit during the gRPC migration.</description>
      <weight>5</weight>
    </relation>
    <relation>
      <source>src/payments</source>
      <target>gRPC</target>
      <type>USES</type>
      <description>The payments module now uses gRPC for its service interface.</description>
      <weight>9</weight>
    </relation>
    <relation>
      <source>src/payments</source>
      <target>Protocol Buffers</target>
      <type>USES</type>
      <description>The payments module uses Protocol Buffer definitions for its gRPC service contract.</description>
      <weight>8</weight>
    </relation>
    <relation>
      <source>Alice Chen</source>
      <target>gRPC</target>
      <type>INTRODUCED</type>
      <description>Alice introduced gRPC to the codebase with the payments service migration.</description>
      <weight>9</weight>
    </relation>
    <relation>
      <source>Alice Chen</source>
      <target>REST to gRPC migration (payments)</target>
      <type>DECIDED</type>
      <description>Alice led the decision and implementation of migrating payments from REST to gRPC.</description>
      <weight>9</weight>
    </relation>
  </relations>
</extraction>
```

---

## 2. Gleaning Prompt (Optional Second Pass)

Used by `src/pipeline/extractor.ts` when gleaning is enabled. The extractor concatenates the original prompt, previous LLM response, and gleaning prompt into a single request (no multi-turn conversation needed).

### User Prompt

```
Review the commit data and your previous extraction above. Are there any entities or relationships you missed? Focus especially on:

1. DECISION entities — architectural choices, migrations, pattern changes
2. Implicit dependencies between modules (co-changes suggest coupling)
3. PATTERN entities — recurring conventions visible across commits

If you find additional entities or relationships, respond with the same XML format containing ONLY the new items. If you found everything already, respond with:

<extraction>
  <entities/>
  <relations/>
</extraction>
```

---

## 3. Community Summary Prompt

Used by `src/pipeline/summarizer.ts` for each community.

### System Prompt

```
You are an expert software engineering analyst writing a knowledge base entry. Your task is to summarize a community of related entities from a git repository's knowledge graph.

A "community" is a cluster of entities (people, modules, technologies, decisions, patterns) that are closely related based on their co-occurrence and relationships in the git history.

Your summary should read like a briefing document that helps a new team member understand:
- What this cluster of code/people/technology is about
- Who the key people are and their roles
- What important decisions were made
- What technologies are used and why
- How the components relate to each other

Write in a factual, concise style. Use present tense for current state, past tense for historical events.
```

### User Prompt Template

```
Summarize this community from the repository's knowledge graph.

Community title (generate a descriptive 3-6 word title):

<community_members>
<entities>
{entityList}
</entities>

<key_relationships>
{relationList}
</key_relationships>
</community_members>

Respond in this format:

<community_summary>
  <title>Your descriptive title here</title>
  <summary>
  Your 2-4 paragraph summary here. Cover:
  1. What this area of the codebase does
  2. Who are the key contributors and their roles
  3. What important technical decisions shaped this area
  4. What technologies/patterns are used
  5. How this area connects to the rest of the system
  </summary>
</community_summary>
```

### Entity/Relation Formatting for Summary Prompt

Entities are formatted as:
```
- [TYPE] Name: Description (first seen: DATE, last seen: DATE, frequency: N)
```

Relations are formatted as:
```
- Source --[TYPE]--> Target: Description (weight: N)
```

### Example

**Input entities:**
```
- [PERSON] Alice Chen: Lead developer driving the payments gRPC migration (first: 2024-03-01, last: 2024-03-04, freq: 3)
- [MODULE] src/payments: Payments service module, gRPC-based (first: 2023-01-15, last: 2024-03-04, freq: 45)
- [MODULE] src/billing: Billing processor module (first: 2023-02-01, last: 2024-03-03, freq: 32)
- [TECHNOLOGY] gRPC: RPC framework for payments service (first: 2024-03-01, last: 2024-03-04, freq: 4)
- [DECISION] REST to gRPC migration (payments): Migration from REST to gRPC (first: 2024-03-01, last: 2024-03-05, freq: 5)
```

**Input relations:**
```
- Alice Chen --[AUTHORED]--> src/payments: Implemented gRPC migration (weight: 9)
- src/billing --[DEPENDS_ON]--> src/payments: Billing calls payments for charges (weight: 8)
- src/payments --[USES]--> gRPC: Service interface (weight: 9)
- Alice Chen --[DECIDED]--> REST to gRPC migration: Led the migration (weight: 9)
```

**Expected output:**
```xml
<community_summary>
  <title>Payments Service & gRPC Migration</title>
  <summary>
  This community centers on the payments service (src/payments) and its recent migration from REST to gRPC, along with the billing module that depends on it. The payments service handles charge operations and is one of the core backend components.

  Alice Chen is the primary contributor and technical decision-maker for this area. She led the REST-to-gRPC migration in early March 2024, which involved rewriting the service handlers, creating Protocol Buffer definitions, and cleaning up deprecated REST routes. Bob Martinez contributed by updating the billing processor to use the new gRPC client.

  The migration to gRPC represents a significant architectural decision, moving from HTTP-based REST endpoints to typed RPC calls with Protocol Buffers. This likely improves type safety and performance for inter-service communication. The billing module's dependency on payments means changes to the payments API surface require coordinated updates to billing.
  </summary>
</community_summary>
```

---

## 4. XML Parsing

All prompts use XML structured output. The parser (`src/pipeline/extractor.ts`) should:

1. Extract content between the outermost XML tags (`<extraction>`, `<community_summary>`).
2. Parse with a lightweight XML parser (e.g., `fast-xml-parser`).
3. Validate required fields are present.
4. Handle missing optional fields gracefully (default weight to 5, empty description to "").
5. Log and skip malformed entities/relations rather than failing the entire chunk.
6. If the LLM response doesn't contain valid XML, retry once before logging the failure and skipping.

Add `fast-xml-parser` to dependencies:
```json
"fast-xml-parser": "^4.5.0"
```

---

## 5. Query Classification Prompt (Runtime)

Used by the `hald_query` tool when `search_type` is `"auto"` to decide between local and global search.

This runs in the MCP tool handler, NOT as a separate LLM call — it's a heuristic:

```typescript
function classifyQuery(question: string): "local" | "global" {
  const localPatterns = [
    /who (knows|owns|maintains|wrote|created|built)/i,
    /find.*(expert|owner|author|maintainer)/i,
    /what (does|is) (the|this) .* (module|file|component|service)/i,
    /show.*(coupling|dependencies|imports)/i,
    /blame/i,
  ];

  const globalPatterns = [
    /why did (we|the team|they)/i,
    /what (was|were) the (reason|decision|motivation)/i,
    /how did .* (evolve|change|migrate|grow)/i,
    /history of/i,
    /overview of/i,
    /tell me about the (architecture|codebase|system)/i,
    /what are the (main|key|major) (components|modules|areas|patterns)/i,
  ];

  for (const pattern of localPatterns) {
    if (pattern.test(question)) return "local";
  }
  for (const pattern of globalPatterns) {
    if (pattern.test(question)) return "global";
  }

  // Default to local — most questions are about specific things
  return "local";
}
```
