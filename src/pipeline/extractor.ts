import { XMLParser } from "fast-xml-parser";
import pLimit from "p-limit";
import type { LLMClient } from "../llm/types.js";
import type { TextUnit, TextUnitId, EntityType, RelationType } from "../shared/types.js";
import { logger } from "../shared/logger.js";

// ================================================================
// Types
// ================================================================

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  description: string;
}

export interface ExtractedRelation {
  source: string;
  target: string;
  type: RelationType;
  description: string;
  weight: number;
}

export interface ExtractorResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

// ================================================================
// Prompts
// ================================================================

const SYSTEM_PROMPT = `You are an expert software engineering analyst. Your task is to extract entities and relationships from git commit history data.

You will receive a chunk of git commit data containing commit messages, author information, file changes, and partial diffs. Your job is to identify the key entities and relationships that capture the institutional knowledge embedded in this history.

## Entity Types

- PERSON: A commit author or contributor. Use their canonical name (not email).
- MODULE: A file, directory, or logical component of the codebase. Normalize paths to the most meaningful level (e.g., "src/billing" not "src/billing/index.ts" unless the specific file is significant).
- TECHNOLOGY: A programming language, framework, library, tool, or protocol mentioned or evidenced in the commits.
- DECISION: An architectural or technical decision that can be inferred from the commits. These are high-value — focus on migrations, refactors, new patterns, deprecations.
- PATTERN: A recurring practice, convention, or code pattern visible across commits.

## Relation Types

- AUTHORED: PERSON → MODULE (person committed changes to this module)
- MODIFIED: PERSON → MODULE (person modified files in this module)
- CO_CHANGED: MODULE → MODULE (modules changed in the same commit)
- USES: MODULE → TECHNOLOGY (module uses this technology)
- DEPENDS_ON: MODULE → MODULE (module imports/requires the other)
- INTRODUCED: PERSON → TECHNOLOGY (person first introduced this technology)
- REMOVED: PERSON → TECHNOLOGY (person removed this technology)
- DECIDED: PERSON → DECISION (person made or championed this decision)
- SUPERSEDES: DECISION → DECISION (new decision replaces an older one)
- EXHIBITS: MODULE → PATTERN (module follows this pattern)

## Output Format

Respond with ONLY the XML below. No other text.

<extraction>
  <entities>
    <entity>
      <name>Canonical name</name>
      <type>ENTITY_TYPE</type>
      <description>1-2 sentence description of what this entity is and why it matters</description>
    </entity>
  </entities>
  <relations>
    <relation>
      <source>Source entity name (must match an entity above)</source>
      <target>Target entity name (must match an entity above)</target>
      <type>RELATION_TYPE</type>
      <description>1 sentence describing this relationship</description>
      <weight>1-10 confidence score</weight>
    </relation>
  </relations>
</extraction>

## Guidelines

1. Focus on HIGH-VALUE entities. Not every file change is an entity — group related files into modules.
2. DECISION entities are the most valuable output. Look for: migrations, new patterns, deprecations, architectural shifts, dependency changes.
3. Assign higher weights to relationships supported by multiple commits in the chunk.
4. Normalize names: "React" not "ReactJS" or "react"; "Alice Chen" not "alice" or "achen@company.com".
5. For PERSON entities, use the full name from the commit author field.
6. For MODULE entities, use the directory path unless a specific file is architecturally significant.
7. Don't extract trivial relationships.`;

function buildUserPrompt(textUnit: TextUnit): string {
  return `Extract entities and relationships from this git commit history:\n\n<commit_data>\n${textUnit.content}\n</commit_data>`;
}

// ================================================================
// XML Parser
// ================================================================

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  isArray: (_name, jpath) =>
    jpath === "extraction.entities.entity" ||
    jpath === "extraction.relations.relation",
  trimValues: true,
});

function extractXmlBlock(text: string, tag: string): string | null {
  const startTag = `<${tag}>`;
  const endTag = `</${tag}>`;
  const start = text.indexOf(startTag);
  const end = text.indexOf(endTag);
  if (start === -1 || end === -1) return null;
  return text.slice(start, end + endTag.length);
}

function parseExtractionXml(text: string): ExtractorResult {
  const xml = extractXmlBlock(text, "extraction");
  if (!xml) return { entities: [], relations: [] };

  const parsed = xmlParser.parse(xml);
  const extraction = parsed?.extraction;
  if (!extraction) return { entities: [], relations: [] };

  const rawEntities = extraction.entities?.entity ?? [];
  const rawRelations = extraction.relations?.relation ?? [];

  const entities: ExtractedEntity[] = [];
  for (const e of rawEntities) {
    if (!e?.name || !e?.type) continue;
    entities.push({
      name: String(e.name).trim(),
      type: String(e.type).trim().toUpperCase() as EntityType,
      description: String(e.description ?? "").trim(),
    });
  }

  const relations: ExtractedRelation[] = [];
  for (const r of rawRelations) {
    if (!r?.source || !r?.target || !r?.type) continue;
    relations.push({
      source: String(r.source).trim(),
      target: String(r.target).trim(),
      type: String(r.type).trim().toUpperCase() as RelationType,
      description: String(r.description ?? "").trim(),
      weight: Math.min(10, Math.max(1, Number(r.weight) || 5)),
    });
  }

  return { entities, relations };
}

// ================================================================
// Extract
// ================================================================

/** Extract entities and relations from a single text unit. */
export async function extract(
  textUnit: TextUnit,
  client: LLMClient,
): Promise<ExtractorResult> {
  const prompt = buildUserPrompt(textUnit);

  const response = await client.extract(prompt, SYSTEM_PROMPT, {
    temperature: 0,
    maxTokens: 4096,
  });

  logger.debug("extractor: LLM response", {
    textUnitId: textUnit.id,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
  });

  const result = parseExtractionXml(response.text);

  // Retry once if we got nothing (LLM sometimes returns preamble)
  if (result.entities.length === 0 && result.relations.length === 0) {
    logger.warn("extractor: empty extraction, retrying", {
      textUnitId: textUnit.id,
    });
    const retry = await client.extract(prompt, SYSTEM_PROMPT, {
      temperature: 0.1,
      maxTokens: 4096,
    });
    return parseExtractionXml(retry.text);
  }

  return result;
}

/** Extract from multiple text units with concurrency control. */
export async function* extractBatch(
  textUnits: TextUnit[],
  client: LLMClient,
  options: {
    concurrency: number;
    onProgress?: (done: number, total: number) => void;
  },
): AsyncIterable<{ textUnitId: TextUnitId; result: ExtractorResult }> {
  const limit = pLimit(options.concurrency);
  let done = 0;

  const tasks = textUnits.map((tu) =>
    limit(async () => {
      try {
        const result = await extract(tu, client);
        done++;
        options.onProgress?.(done, textUnits.length);
        return { textUnitId: tu.id, result };
      } catch (err) {
        logger.error("extractor: failed to extract", {
          textUnitId: tu.id,
          error: String(err),
        });
        done++;
        options.onProgress?.(done, textUnits.length);
        return {
          textUnitId: tu.id,
          result: { entities: [], relations: [] },
        };
      }
    }),
  );

  for (const task of tasks) {
    yield await task;
  }
}

// Exported for testing
export { parseExtractionXml, SYSTEM_PROMPT };
