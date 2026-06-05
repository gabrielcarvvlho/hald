import { describe, it, expect } from "vitest";
import {
  formatLocalResult,
  formatGlobalResult,
  formatDecisionTrace,
} from "../../src/mcp/formatters.js";
import type { DecisionTraceInput } from "../../src/mcp/formatters.js";
import type { LocalSearchResult, ScoredEntity, AnnotatedRelation } from "../../src/query/local-search.js";
import type { GlobalSearchResult } from "../../src/query/global-search.js";
import { EntityType, RelationType } from "../../src/shared/types.js";
import type { Entity, Relation, TextUnit, Community } from "../../src/shared/types.js";

// ================================================================
// Fixtures
// ================================================================

function makeEntity(over: Partial<Entity> = {}): Entity {
  return {
    id: "module:src/payments",
    type: EntityType.MODULE,
    name: "src/payments",
    aliases: [],
    description: "Payments service module",
    firstSeen: "2024-01-15T00:00:00Z",
    lastSeen: "2024-06-10T00:00:00Z",
    frequency: 15,
    metadata: {},
    ...over,
  };
}

function makeScoredEntity(over: Partial<ScoredEntity> = {}): ScoredEntity {
  return {
    ...makeEntity(),
    score: 0.5,
    isSeed: true,
    hopDistance: 0,
    degree: 3,
    ...over,
  };
}

function makeAnnotatedRelation(over: Partial<AnnotatedRelation> = {}): AnnotatedRelation {
  return {
    id: "rel:alice-payments",
    type: RelationType.AUTHORED,
    sourceId: "person:alice-chen",
    targetId: "module:src/payments",
    weight: 9,
    description: "Alice authored payments",
    evidence: ["tu:001"],
    firstSeen: "2024-01-15",
    lastSeen: "2024-06-10",
    sourceName: "Alice Chen",
    targetName: "src/payments",
    ...over,
  };
}

function makeTextUnit(over: Partial<TextUnit> = {}): TextUnit {
  return {
    id: "tu:001",
    content: "Alice migrated payments from REST to gRPC",
    commitHashes: ["abc123"],
    dateRange: { start: "2024-03-01T00:00:00Z", end: "2024-03-05T00:00:00Z" },
    entityIds: ["person:alice-chen", "module:src/payments"],
    relationIds: ["rel:alice-payments"],
    ...over,
  };
}

function makeCommunity(over: Partial<Community> = {}): Community {
  return {
    id: "comm:0:0",
    level: 0,
    title: "Payments & gRPC",
    summary: "Payments migration to gRPC, led by Alice.",
    entityIds: ["person:alice-chen", "module:src/payments"],
    childIds: [],
    ...over,
  };
}

// ================================================================
// formatLocalResult
// ================================================================

describe("formatLocalResult", () => {
  it("renders entities, relations, communities, and evidence in order", () => {
    const result: LocalSearchResult = {
      query: "payments",
      entities: [
        makeScoredEntity({ name: "src/payments", type: EntityType.MODULE, isSeed: true, score: 0.87 }),
        makeScoredEntity({
          id: "person:alice-chen",
          name: "Alice Chen",
          type: EntityType.PERSON,
          isSeed: false,
          hopDistance: 1,
          score: 0.42,
          description: "Lead developer",
          lastSeen: "2024-06-15T00:00:00Z",
        }),
      ],
      relations: [makeAnnotatedRelation()],
      textUnits: [makeTextUnit()],
      communities: [makeCommunity()],
      totalEntityMatches: 5,
      totalRelations: 1,
    };

    const out = formatLocalResult(result);

    expect(out).toMatchInlineSnapshot(`
      "## Entities (2 of 5 matches)

      **MODULE**
      - **src/payments** (direct match, score 0.87) — Payments service module [last active: 2024-06-10]

      **PERSON**
      - **Alice Chen** (1-hop, score 0.42) — Lead developer [last active: 2024-06-15]

      ## Relationships

      **AUTHORED**
      - Alice Chen → src/payments (weight: 9) — Alice authored payments

      ## Community Context

      ### Payments & gRPC
      Payments migration to gRPC, led by Alice.

      ## Supporting Evidence (commit history)

      ### 2024-03-01 to 2024-03-05
      \`\`\`
      Alice migrated payments from REST to gRPC
      \`\`\`
      "
    `);
  });

  it("omits the match-count suffix when all matches are shown", () => {
    const result: LocalSearchResult = {
      query: "x",
      entities: [makeScoredEntity()],
      relations: [],
      textUnits: [],
      communities: [],
      totalEntityMatches: 1,
      totalRelations: 0,
    };
    expect(formatLocalResult(result)).toContain("## Entities\n");
    expect(formatLocalResult(result)).not.toContain("of 1 matches");
  });

  it("returns a friendly empty message when nothing matched", () => {
    const result: LocalSearchResult = {
      query: "x",
      entities: [],
      relations: [],
      textUnits: [],
      communities: [],
      totalEntityMatches: 0,
      totalRelations: 0,
    };
    expect(formatLocalResult(result)).toBe(
      "No relevant information found in the knowledge graph for this query.",
    );
  });
});

// ================================================================
// formatGlobalResult
// ================================================================

describe("formatGlobalResult", () => {
  it("renders key entities then community summaries", () => {
    const result: GlobalSearchResult = {
      communities: [makeCommunity()],
      topEntities: [makeEntity({ id: "person:alice-chen", name: "Alice Chen", type: EntityType.PERSON, description: "Lead developer" })],
      totalCommunities: 3,
    };

    expect(formatGlobalResult(result)).toMatchInlineSnapshot(`
      "## Key Entities

      - **Alice Chen** [PERSON] — Lead developer

      ## Community Summaries (1 of 3)

      ### Payments & gRPC

      Payments migration to gRPC, led by Alice.
      "
    `);
  });

  it("returns a friendly empty message when no communities matched", () => {
    const result: GlobalSearchResult = {
      communities: [],
      topEntities: [],
      totalCommunities: 0,
    };
    expect(formatGlobalResult(result)).toBe(
      "No relevant community summaries found for this query.",
    );
  });
});

// ================================================================
// formatDecisionTrace
// ================================================================

describe("formatDecisionTrace", () => {
  it("renders makers, decisions, timeline, modules, tech, and supersessions", () => {
    const alice = makeEntity({ id: "person:alice-chen", name: "Alice Chen", type: EntityType.PERSON, description: "Lead dev" });
    const decision = makeEntity({
      id: "decision:rest-to-grpc",
      name: "REST to gRPC migration",
      type: EntityType.DECISION,
      description: "Migrate payments to gRPC",
      firstSeen: "2024-03-01T00:00:00Z",
      lastSeen: "2024-06-01T00:00:00Z",
    });
    const oldDecision = makeEntity({
      id: "decision:rest-api",
      name: "REST API",
      type: EntityType.DECISION,
    });
    const moduleEntity = makeEntity();
    const tech = makeEntity({ id: "technology:grpc", name: "gRPC", type: EntityType.TECHNOLOGY, description: "RPC framework" });

    const decided: Relation = {
      id: "rel:alice-decided",
      type: RelationType.DECIDED,
      sourceId: "person:alice-chen",
      targetId: "decision:rest-to-grpc",
      weight: 9,
      description: "Alice led the migration",
      evidence: [],
      firstSeen: "2024-03-01",
      lastSeen: "2024-06-01",
    };
    const supersedes: Relation = {
      id: "rel:supersedes",
      type: RelationType.SUPERSEDES,
      sourceId: "decision:rest-to-grpc",
      targetId: "decision:rest-api",
      weight: 5,
      description: "gRPC replaces REST",
      evidence: [],
      firstSeen: "2024-03-01",
      lastSeen: "2024-06-01",
    };

    const input: DecisionTraceInput = {
      topic: "gRPC migration",
      decisionEntities: [decision],
      decidedRelations: [decided],
      supersededRelations: [supersedes],
      affectedModules: [moduleEntity],
      techEntities: [tech],
      timeline: [makeTextUnit()],
      entityMap: new Map([
        [alice.id, alice],
        [decision.id, decision],
        [oldDecision.id, oldDecision],
      ]),
    };

    expect(formatDecisionTrace(input)).toMatchInlineSnapshot(`
      "## Decision Trace: "gRPC migration"

      ### Decision Makers

      - **Alice Chen** — Alice led the migration (weight: 9)

      ### Decisions

      - **REST to gRPC migration** (2024-03-01 to 2024-06-01) — Migrate payments to gRPC

      ### Timeline

      **2024-03-01 to 2024-03-05**
      Alice migrated payments from REST to gRPC

      ### Affected Modules

      - **src/payments** — Payments service module (15 changes)

      ### Technologies

      - **gRPC** — RPC framework

      ### Superseded Decisions

      - **REST to gRPC migration** supersedes **REST API** — gRPC replaces REST
      "
    `);
  });

  it("renders only the header when nothing relevant was found", () => {
    const input: DecisionTraceInput = {
      topic: "nothing",
      decisionEntities: [],
      decidedRelations: [],
      supersededRelations: [],
      affectedModules: [],
      techEntities: [],
      timeline: [],
      entityMap: new Map(),
    };
    expect(formatDecisionTrace(input)).toBe('## Decision Trace: "nothing"\n');
  });
});
