// ================================================================
// Markdown formatters for MCP tool output
// ================================================================
//
// Pure functions that render query-engine results into the Markdown
// returned by the hald_* MCP tools. Kept separate from tools.ts (the
// tool-registration glue) so they can be unit-tested in isolation and
// reused without standing up an MCP server.

import type { LocalSearchResult } from "../query/local-search.js";
import type { GlobalSearchResult } from "../query/global-search.js";
import type { Entity, Relation, TextUnit } from "../shared/types.js";

export function formatLocalResult(result: LocalSearchResult): string {
  const sections: string[] = [];

  // Group entities by type for clearer reading
  if (result.entities.length > 0) {
    const matchInfo =
      result.totalEntityMatches > result.entities.length
        ? ` (${result.entities.length} of ${result.totalEntityMatches} matches)`
        : "";
    sections.push(`## Entities${matchInfo}\n`);

    const grouped = new Map<string, typeof result.entities>();
    for (const e of result.entities) {
      const list = grouped.get(e.type) ?? [];
      list.push(e);
      grouped.set(e.type, list);
    }

    for (const [type, entities] of grouped) {
      sections.push(`**${type}**`);
      for (const e of entities) {
        const relevance = e.isSeed ? "direct match" : `${e.hopDistance}-hop`;
        const lastSeen = e.lastSeen.split("T")[0] ?? e.lastSeen;
        sections.push(`- **${e.name}** (${relevance}, score ${e.score.toFixed(2)}) — ${e.description} [last active: ${lastSeen}]`);
      }
      sections.push("");
    }
  }

  if (result.relations.length > 0) {
    sections.push("## Relationships\n");
    // Group relations by type for clarity
    const relByType = new Map<string, typeof result.relations>();
    for (const r of result.relations) {
      const list = relByType.get(r.type) ?? [];
      list.push(r);
      relByType.set(r.type, list);
    }

    for (const [type, rels] of relByType) {
      sections.push(`**${type}**`);
      for (const r of rels) {
        const desc = r.description ? ` — ${r.description}` : "";
        sections.push(`- ${r.sourceName} → ${r.targetName} (weight: ${r.weight})${desc}`);
      }
      sections.push("");
    }
  }

  if (result.communities.length > 0) {
    sections.push("## Community Context\n");
    for (const c of result.communities) {
      sections.push(`### ${c.title}\n${c.summary}\n`);
    }
  }

  if (result.textUnits.length > 0) {
    sections.push("## Supporting Evidence (commit history)\n");
    for (const tu of result.textUnits) {
      const start = tu.dateRange.start.split("T")[0] ?? tu.dateRange.start;
      const end = tu.dateRange.end.split("T")[0] ?? tu.dateRange.end;
      sections.push(`### ${start} to ${end}\n\`\`\`\n${tu.content}\n\`\`\`\n`);
    }
  }

  if (sections.length === 0) {
    return "No relevant information found in the knowledge graph for this query.";
  }

  return sections.join("\n");
}

export function formatGlobalResult(result: GlobalSearchResult): string {
  if (result.communities.length === 0) {
    return "No relevant community summaries found for this query.";
  }

  const sections: string[] = [];

  if (result.topEntities.length > 0) {
    sections.push("## Key Entities\n");
    for (const e of result.topEntities) {
      sections.push(`- **${e.name}** [${e.type}] — ${e.description}`);
    }
    sections.push("");
  }

  sections.push(`## Community Summaries (${result.communities.length} of ${result.totalCommunities})\n`);
  for (const c of result.communities) {
    sections.push(`### ${c.title}\n\n${c.summary}\n`);
  }
  return sections.join("\n");
}

export interface DecisionTraceInput {
  topic: string;
  decisionEntities: Entity[];
  decidedRelations: Relation[];
  supersededRelations: Relation[];
  affectedModules: Entity[];
  techEntities: Entity[];
  timeline: TextUnit[];
  entityMap: Map<string, Entity>;
}

export function formatDecisionTrace(input: DecisionTraceInput): string {
  const {
    topic,
    decisionEntities,
    decidedRelations,
    supersededRelations,
    affectedModules,
    techEntities,
    timeline,
    entityMap,
  } = input;

  const sections: string[] = [`## Decision Trace: "${topic}"\n`];

  // Decision Makers
  const makerIds = new Set(decidedRelations.map((r) => r.sourceId));
  const makers = [...makerIds]
    .map((id) => entityMap.get(id))
    .filter((e): e is Entity => e !== undefined);

  if (makers.length > 0) {
    sections.push("### Decision Makers\n");
    for (const maker of makers) {
      const rel = decidedRelations.find((r) => r.sourceId === maker.id);
      const weight = rel ? ` (weight: ${rel.weight})` : "";
      const desc = rel?.description ? ` — ${rel.description}` : maker.description ? ` — ${maker.description}` : "";
      sections.push(`- **${maker.name}**${desc}${weight}`);
    }
    sections.push("");
  }

  // Core Decisions
  if (decisionEntities.length > 0) {
    sections.push("### Decisions\n");
    for (const d of decisionEntities) {
      const firstSeen = d.firstSeen.split("T")[0] ?? d.firstSeen;
      const lastSeen = d.lastSeen.split("T")[0] ?? d.lastSeen;
      const period = firstSeen === lastSeen ? firstSeen : `${firstSeen} to ${lastSeen}`;
      sections.push(`- **${d.name}** (${period})${d.description ? ` — ${d.description}` : ""}`);
    }
    sections.push("");
  }

  // Timeline
  if (timeline.length > 0) {
    sections.push("### Timeline\n");
    for (const tu of timeline) {
      const start = tu.dateRange.start.split("T")[0] ?? tu.dateRange.start;
      const end = tu.dateRange.end.split("T")[0] ?? tu.dateRange.end;
      const period = start === end ? `**${start}**` : `**${start} to ${end}**`;
      // Trim content to a brief summary (first non-empty line)
      const firstLine = tu.content.split("\n").find((l) => l.trim().length > 0) ?? tu.content;
      const snippet = firstLine.length > 200 ? firstLine.slice(0, 200) + "…" : firstLine;
      sections.push(`${period}\n${snippet}\n`);
    }
  }

  // Affected Modules
  if (affectedModules.length > 0) {
    sections.push("### Affected Modules\n");
    for (const m of affectedModules) {
      sections.push(`- **${m.name}**${m.description ? ` — ${m.description}` : ""} (${m.frequency} changes)`);
    }
    sections.push("");
  }

  // Technologies
  if (techEntities.length > 0) {
    sections.push("### Technologies\n");
    for (const t of techEntities) {
      sections.push(`- **${t.name}**${t.description ? ` — ${t.description}` : ""}`);
    }
    sections.push("");
  }

  // Superseded Decisions (only show if present)
  if (supersededRelations.length > 0) {
    sections.push("### Superseded Decisions\n");
    for (const r of supersededRelations) {
      const from = entityMap.get(r.sourceId)?.name ?? r.sourceId;
      const to = entityMap.get(r.targetId)?.name ?? r.targetId;
      const desc = r.description ? ` — ${r.description}` : "";
      sections.push(`- **${from}** supersedes **${to}**${desc}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}
