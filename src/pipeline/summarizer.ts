import { XMLParser } from "fast-xml-parser";
import pLimit from "p-limit";
import type { LLMClient } from "../llm/types.js";
import type { Community, CommunityId, Entity, Relation } from "../shared/types.js";
import type { TokenAccumulator } from "./extractor.js";
import { logger } from "../shared/logger.js";

// ================================================================
// Prompts
// ================================================================

const SYSTEM_PROMPT = `You are an expert software engineering analyst writing a knowledge base entry. Your task is to summarize a community of related entities from a git repository's knowledge graph.

A "community" is a cluster of entities (people, modules, technologies, decisions, patterns) that are closely related based on their co-occurrence and relationships in the git history.

Your summary should read like a briefing document that helps a new team member understand:
- What this cluster of code/people/technology is about
- Who the key people are and their roles
- What important decisions were made
- What technologies are used and why
- How the components relate to each other

Write in a factual, concise style. Use present tense for current state, past tense for historical events.`;

function buildSummaryPrompt(
  community: Community,
  memberEntities: Entity[],
  memberRelations: Relation[],
): string {
  // Build id → name lookup so relations show human-readable names
  const nameById = new Map(memberEntities.map((e) => [e.id, e.name]));

  const entityList = memberEntities
    .map(
      (e) =>
        `- [${e.type}] ${e.name}: ${e.description} (first: ${e.firstSeen || "unknown"}, last: ${e.lastSeen || "unknown"}, freq: ${e.frequency})`,
    )
    .join("\n");

  const relationList = memberRelations
    .map((r) => {
      const sourceName = nameById.get(r.sourceId) ?? r.sourceId;
      const targetName = nameById.get(r.targetId) ?? r.targetId;
      return `- ${sourceName} --[${r.type}]--> ${targetName}: ${r.description} (weight: ${r.weight})`;
    })
    .join("\n");

  return `Summarize this community from the repository's knowledge graph.

Community title (generate a descriptive 3-6 word title):

<community_members>
<entities>
${entityList}
</entities>

<key_relationships>
${relationList}
</key_relationships>
</community_members>

Respond in this format:

<community_summary>
  <title>Your descriptive title here</title>
  <summary>
  Your 2-4 paragraph summary here.
  </summary>
</community_summary>`;
}

// ================================================================
// XML Parser
// ================================================================

const xmlParser = new XMLParser({
  ignoreAttributes: true,
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

export interface SummaryResult {
  title: string;
  summary: string;
}

interface SummaryResultWithTokens extends SummaryResult {
  inputTokens: number;
  outputTokens: number;
}

function parseSummaryXml(text: string): SummaryResult {
  const xml = extractXmlBlock(text, "community_summary");
  if (!xml) return { title: "", summary: text.trim() };

  // Try parsing, with sanitization fallback for bare ampersands
  const parsed = safeParseXml(xml);
  if (!parsed) return { title: "", summary: text.trim() };

  const cs = parsed?.community_summary;
  if (!cs) return { title: "", summary: text.trim() };

  return {
    title: String(cs.title ?? "").trim(),
    summary: String(cs.summary ?? "").trim(),
  };
}

/** Attempt XML parse with ampersand sanitization fallback. */
function safeParseXml(xml: string) {
  try {
    return xmlParser.parse(xml);
  } catch (err) {
    logger.warn("summarizer: XML parse failed, attempting sanitization", {
      error: String(err),
      xmlPreview: xml.slice(0, 200),
    });
    const sanitized = xml.replace(/&(?!(?:amp|lt|gt|apos|quot);)/g, "&amp;");
    try {
      return xmlParser.parse(sanitized);
    } catch (retryErr) {
      logger.error("summarizer: XML parse failed after sanitization", {
        error: String(retryErr),
      });
      return null;
    }
  }
}

// ================================================================
// Summarize
// ================================================================

/** Generate summary for a single community. */
async function summarize(
  community: Community,
  memberEntities: Entity[],
  memberRelations: Relation[],
  client: LLMClient,
): Promise<SummaryResultWithTokens> {
  const prompt = buildSummaryPrompt(community, memberEntities, memberRelations);

  const response = await client.extract(prompt, SYSTEM_PROMPT, {
    temperature: 0.2,
    maxTokens: 2048,
  });

  logger.debug("summarizer: LLM response", {
    communityId: community.id,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
  });

  const parsed = parseSummaryXml(response.text);
  return {
    ...parsed,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
  };
}

/** Summarize all communities with concurrency control. */
export async function* summarizeBatch(
  communities: Community[],
  entities: Entity[],
  relations: Relation[],
  client: LLMClient,
  options: { concurrency: number; tokenUsage?: TokenAccumulator },
): AsyncIterable<{ communityId: CommunityId; result: SummaryResult }> {
  const limit = pLimit(options.concurrency);

  const entityMap = new Map(entities.map((e) => [e.id, e]));

  const tasks = communities.map((community) =>
    limit(async () => {
      const memberEntities = community.entityIds
        .map((id) => entityMap.get(id))
        .filter((e): e is Entity => e !== undefined);

      const memberEntityIds = new Set(community.entityIds);
      const memberRelations = relations.filter(
        (r) => memberEntityIds.has(r.sourceId) || memberEntityIds.has(r.targetId),
      );

      try {
        const result = await summarize(community, memberEntities, memberRelations, client);
        if (options.tokenUsage) {
          options.tokenUsage.inputTokens += result.inputTokens;
          options.tokenUsage.outputTokens += result.outputTokens;
          options.tokenUsage.requestCount++;
        }
        return { communityId: community.id, result };
      } catch (err) {
        logger.error("summarizer: failed", {
          communityId: community.id,
          error: String(err),
        });
        if (options.tokenUsage) {
          options.tokenUsage.failedCount++;
        }
        return {
          communityId: community.id,
          result: { title: "", summary: "" },
        };
      }
    }),
  );

  for (const task of tasks) {
    yield await task;
  }
}

// Exported for testing
export { parseSummaryXml };
