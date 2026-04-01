import { XMLParser } from "fast-xml-parser";
import pLimit from "p-limit";
import type { LLMClient } from "../llm/types.js";
import type { TextUnit, TextUnitId } from "../shared/types.js";
import { EntityType, RelationType } from "../shared/types.js";
import { logger } from "../shared/logger.js";

const VALID_ENTITY_TYPES = new Set(Object.values(EntityType));
const VALID_RELATION_TYPES = new Set(Object.values(RelationType));

// Relation type constraints: which entity types are valid for source and target
const RELATION_CONSTRAINTS: Record<
  RelationType,
  { source: EntityType[]; target: EntityType[] }
> = {
  [RelationType.AUTHORED]: {
    source: [EntityType.PERSON],
    target: [EntityType.MODULE],
  },
  [RelationType.MODIFIED]: {
    source: [EntityType.PERSON],
    target: [EntityType.MODULE],
  },
  [RelationType.CO_CHANGED]: {
    source: [EntityType.MODULE],
    target: [EntityType.MODULE],
  },
  [RelationType.USES]: {
    source: [EntityType.MODULE],
    target: [EntityType.TECHNOLOGY],
  },
  [RelationType.DEPENDS_ON]: {
    source: [EntityType.MODULE],
    target: [EntityType.MODULE],
  },
  [RelationType.INTRODUCED]: {
    source: [EntityType.PERSON],
    target: [EntityType.TECHNOLOGY],
  },
  [RelationType.REMOVED]: {
    source: [EntityType.PERSON],
    target: [EntityType.TECHNOLOGY],
  },
  [RelationType.DECIDED]: {
    source: [EntityType.PERSON],
    target: [EntityType.DECISION],
  },
  [RelationType.SUPERSEDES]: {
    source: [EntityType.DECISION],
    target: [EntityType.DECISION],
  },
  [RelationType.EXHIBITS]: {
    source: [EntityType.MODULE],
    target: [EntityType.PATTERN],
  },
};

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

export interface TokenAccumulator {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  failedCount: number;
}

// ================================================================
// Prompts
// ================================================================

const SYSTEM_PROMPT = `You are an expert software engineering analyst. Your task is to extract entities and relationships from git commit history data.

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
7. Don't extract trivial relationships.
8. Do NOT extract:
   - Generic commit messages as DECISION entities ("fix typo", "update deps")
   - Individual test files as MODULE entities (group under test directories)
   - PERSON entities from co-authors or merge-by users who didn't write the code
   - TECHNOLOGY entities for languages obvious from file extensions alone (e.g., don't extract "TypeScript" just because files end in .ts — only extract it if a commit explicitly adopts or configures it)`;

const GLEANING_PROMPT = `Review the commit data and your previous extraction above. Are there any entities or relationships you missed? Focus especially on:

1. DECISION entities — architectural choices, migrations, pattern changes
2. Implicit dependencies between modules (co-changes suggest coupling)
3. PATTERN entities — recurring conventions visible across commits

If you find additional entities or relationships, respond with the same XML format containing ONLY the new items. If you found everything already, respond with:

<extraction>
  <entities/>
  <relations/>
</extraction>`;

function buildUserPrompt(textUnit: TextUnit): string {
  return `Extract entities and relationships from this git commit history:\n\n<commit_data>\n${textUnit.content}\n</commit_data>`;
}

function buildGleaningPrompt(
  textUnit: TextUnit,
  previousResponse: string,
): string {
  return `${buildUserPrompt(textUnit)}\n\n--- Your previous extraction ---\n${previousResponse}\n\n--- Review ---\n${GLEANING_PROMPT}`;
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

/** Strip markdown code fences that some LLMs wrap around XML output. */
function stripCodeFences(text: string): string {
  return text.replace(/```(?:xml)?\s*\n?/g, "");
}

function extractXmlBlock(text: string, tag: string): string | null {
  const startTag = `<${tag}>`;
  const endTag = `</${tag}>`;
  const start = text.indexOf(startTag);
  const end = text.indexOf(endTag);
  if (start === -1 || end === -1) return null;
  return text.slice(start, end + endTag.length);
}

/** Attempt to parse XML, with sanitization fallback for bare ampersands. */
function safeParseXml(xml: string) {
  try {
    return xmlParser.parse(xml);
  } catch (err) {
    logger.warn("extractor: XML parse failed, attempting sanitization", {
      error: String(err),
      xmlPreview: xml.slice(0, 200),
    });
    const sanitized = xml.replace(/&(?!(?:amp|lt|gt|apos|quot);)/g, "&amp;");
    try {
      return xmlParser.parse(sanitized);
    } catch (retryErr) {
      logger.error("extractor: XML parse failed after sanitization", {
        error: String(retryErr),
      });
      return null;
    }
  }
}

function parseExtractionXml(text: string): ExtractorResult {
  const cleaned = stripCodeFences(text);
  const xml = extractXmlBlock(cleaned, "extraction");
  if (!xml) return { entities: [], relations: [] };

  const parsed = safeParseXml(xml);
  if (!parsed) return { entities: [], relations: [] };

  const extraction = parsed?.extraction;
  if (!extraction) return { entities: [], relations: [] };

  const rawEntities = extraction.entities?.entity ?? [];
  const rawRelations = extraction.relations?.relation ?? [];

  const entities: ExtractedEntity[] = [];
  for (const e of rawEntities) {
    if (!e?.name || !e?.type) continue;
    const type = String(e.type).trim().toUpperCase();
    if (!VALID_ENTITY_TYPES.has(type as EntityType)) continue;
    entities.push({
      name: String(e.name).trim(),
      type: type as EntityType,
      description: String(e.description ?? "").trim(),
    });
  }

  // Build lookup for relation constraint validation
  const entityTypeByName = new Map(entities.map((e) => [e.name, e.type]));

  const relations: ExtractedRelation[] = [];
  for (const r of rawRelations) {
    if (!r?.source || !r?.target || !r?.type) continue;
    const type = String(r.type).trim().toUpperCase();
    if (!VALID_RELATION_TYPES.has(type as RelationType)) continue;

    const sourceName = String(r.source).trim();
    const targetName = String(r.target).trim();

    // Validate source/target entity type constraints when both entities are known
    const constraint = RELATION_CONSTRAINTS[type as RelationType];
    const sourceType = entityTypeByName.get(sourceName);
    const targetType = entityTypeByName.get(targetName);
    if (constraint && sourceType && targetType) {
      if (
        !constraint.source.includes(sourceType) ||
        !constraint.target.includes(targetType)
      ) {
        logger.warn("extractor: relation type/entity type mismatch, skipping", {
          relation: type,
          source: `${sourceName} (${sourceType})`,
          target: `${targetName} (${targetType})`,
          expected: `${constraint.source.join("|")} → ${constraint.target.join("|")}`,
        });
        continue;
      }
    }

    relations.push({
      source: sourceName,
      target: targetName,
      type: type as RelationType,
      description: String(r.description ?? "").trim(),
      weight: Math.min(10, Math.max(1, Number(r.weight) || 5)),
    });
  }

  return { entities, relations };
}

// ================================================================
// Gleaning
// ================================================================

const DEFAULT_GLEANING_THRESHOLD = {
  minCommits: 8,
  maxEntitiesRatio: 0.5, // fewer than 1 entity per 2 commits → glean
};

function shouldGlean(result: ExtractorResult, textUnit: TextUnit): boolean {
  if (textUnit.commitHashes.length < DEFAULT_GLEANING_THRESHOLD.minCommits) {
    return false;
  }
  const ratio = result.entities.length / textUnit.commitHashes.length;
  return ratio < DEFAULT_GLEANING_THRESHOLD.maxEntitiesRatio;
}

function mergeResults(
  base: ExtractorResult,
  extra: ExtractorResult,
): ExtractorResult {
  return {
    entities: [...base.entities, ...extra.entities],
    relations: [...base.relations, ...extra.relations],
  };
}

// ================================================================
// Extract
// ================================================================

/** Extract entities and relations from a single text unit. */
export async function extract(
  textUnit: TextUnit,
  client: LLMClient,
  options?: { enableGleaning?: boolean },
): Promise<ExtractorResult & { inputTokens: number; outputTokens: number }> {
  const prompt = buildUserPrompt(textUnit);

  const response = await client.extract(prompt, SYSTEM_PROMPT, {
    temperature: 0,
    maxTokens: 4096,
  });

  let totalInputTokens = response.inputTokens;
  let totalOutputTokens = response.outputTokens;
  // Track the latest response text for potential gleaning prompt
  let latestResponseText = response.text;

  logger.debug("extractor: LLM response", {
    textUnitId: textUnit.id,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    stopReason: response.stopReason,
  });

  // Handle truncated responses — retry with a higher token limit
  if (response.stopReason === "max_tokens") {
    logger.warn(
      "extractor: response truncated at max_tokens, retrying with higher limit",
      { textUnitId: textUnit.id },
    );
    const retry = await client.extract(prompt, SYSTEM_PROMPT, {
      temperature: 0,
      maxTokens: 8192,
    });
    totalInputTokens += retry.inputTokens;
    totalOutputTokens += retry.outputTokens;

    if (retry.stopReason === "max_tokens") {
      logger.error("extractor: still truncated at 8192 tokens", {
        textUnitId: textUnit.id,
      });
    }

    const result = parseExtractionXml(retry.text);
    return {
      ...result,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    };
  }

  let result = parseExtractionXml(response.text);

  // Retry once if we got nothing (LLM sometimes returns preamble instead of XML)
  if (result.entities.length === 0 && result.relations.length === 0) {
    logger.warn("extractor: empty extraction, retrying", {
      textUnitId: textUnit.id,
    });
    const retry = await client.extract(prompt, SYSTEM_PROMPT, {
      temperature: 0.1,
      maxTokens: 4096,
    });
    totalInputTokens += retry.inputTokens;
    totalOutputTokens += retry.outputTokens;
    latestResponseText = retry.text;
    result = parseExtractionXml(retry.text);
  }

  // Gleaning pass: ask the LLM to review its output and find missed entities
  if (options?.enableGleaning && shouldGlean(result, textUnit)) {
    logger.debug("extractor: triggering gleaning pass", {
      textUnitId: textUnit.id,
      commits: textUnit.commitHashes.length,
      entitiesFound: result.entities.length,
    });
    const gleanPrompt = buildGleaningPrompt(textUnit, latestResponseText);
    const gleanResponse = await client.extract(gleanPrompt, SYSTEM_PROMPT, {
      temperature: 0,
      maxTokens: 4096,
    });
    totalInputTokens += gleanResponse.inputTokens;
    totalOutputTokens += gleanResponse.outputTokens;

    const gleanResult = parseExtractionXml(gleanResponse.text);
    if (gleanResult.entities.length > 0 || gleanResult.relations.length > 0) {
      logger.debug("extractor: gleaning found additional items", {
        textUnitId: textUnit.id,
        newEntities: gleanResult.entities.length,
        newRelations: gleanResult.relations.length,
      });
      result = mergeResults(result, gleanResult);
    }
  }

  return {
    ...result,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
  };
}

/** Extract from multiple text units with concurrency control. */
export async function* extractBatch(
  textUnits: TextUnit[],
  client: LLMClient,
  options: {
    concurrency: number;
    enableGleaning?: boolean;
    onProgress?: (done: number, total: number) => void;
    tokenUsage?: TokenAccumulator;
  },
): AsyncIterable<{
  textUnitId: TextUnitId;
  result: ExtractorResult;
  failed?: boolean;
}> {
  const limit = pLimit(options.concurrency);
  let done = 0;

  const tasks = textUnits.map((tu) =>
    limit(async () => {
      try {
        const result = await extract(tu, client, {
          enableGleaning: options.enableGleaning,
        });
        if (options.tokenUsage) {
          options.tokenUsage.inputTokens += result.inputTokens;
          options.tokenUsage.outputTokens += result.outputTokens;
          options.tokenUsage.requestCount++;
        }
        done++;
        options.onProgress?.(done, textUnits.length);
        return {
          textUnitId: tu.id,
          result: {
            entities: result.entities,
            relations: result.relations,
          },
        };
      } catch (err) {
        logger.error("extractor: failed to extract", {
          textUnitId: tu.id,
          error: String(err),
        });
        if (options.tokenUsage) {
          options.tokenUsage.failedCount++;
        }
        done++;
        options.onProgress?.(done, textUnits.length);
        return {
          textUnitId: tu.id,
          result: { entities: [], relations: [] },
          failed: true,
        };
      }
    }),
  );

  for (const task of tasks) {
    yield await task;
  }
}

// Exported for testing
export {
  parseExtractionXml,
  SYSTEM_PROMPT,
  GLEANING_PROMPT,
  shouldGlean,
  stripCodeFences,
};
