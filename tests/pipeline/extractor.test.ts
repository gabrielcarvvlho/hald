import { describe, it, expect } from "vitest";
import { parseExtractionXml, shouldGlean, stripCodeFences } from "../../src/pipeline/extractor.js";
import { EntityType } from "../../src/shared/types.js";
import type { TextUnit } from "../../src/shared/types.js";

describe("extractor — XML parsing", () => {
  it("parses a well-formed extraction response", () => {
    const xml = `
<extraction>
  <entities>
    <entity>
      <name>Alice Chen</name>
      <type>PERSON</type>
      <description>Lead developer of payments</description>
    </entity>
    <entity>
      <name>src/payments</name>
      <type>MODULE</type>
      <description>Payments service module</description>
    </entity>
  </entities>
  <relations>
    <relation>
      <source>Alice Chen</source>
      <target>src/payments</target>
      <type>AUTHORED</type>
      <description>Alice implemented the payments module</description>
      <weight>9</weight>
    </relation>
  </relations>
</extraction>`;

    const result = parseExtractionXml(xml);

    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]!.name).toBe("Alice Chen");
    expect(result.entities[0]!.type).toBe("PERSON");
    expect(result.entities[1]!.name).toBe("src/payments");
    expect(result.entities[1]!.type).toBe("MODULE");

    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]!.source).toBe("Alice Chen");
    expect(result.relations[0]!.target).toBe("src/payments");
    expect(result.relations[0]!.type).toBe("AUTHORED");
    expect(result.relations[0]!.weight).toBe(9);
  });

  it("handles XML wrapped in preamble text", () => {
    const text = `Here are the extracted entities and relationships:

<extraction>
  <entities>
    <entity>
      <name>Bob</name>
      <type>PERSON</type>
      <description>Developer</description>
    </entity>
  </entities>
  <relations/>
</extraction>

I hope this helps!`;

    const result = parseExtractionXml(text);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.name).toBe("Bob");
  });

  it("handles single entity (not wrapped in array)", () => {
    const xml = `<extraction>
  <entities>
    <entity>
      <name>Solo</name>
      <type>TECHNOLOGY</type>
      <description>A technology</description>
    </entity>
  </entities>
  <relations/>
</extraction>`;

    const result = parseExtractionXml(xml);
    expect(result.entities).toHaveLength(1);
  });

  it("clamps weight to 1-10 range", () => {
    const xml = `<extraction>
  <entities>
    <entity><name>A</name><type>PERSON</type><description>a</description></entity>
    <entity><name>B</name><type>MODULE</type><description>b</description></entity>
  </entities>
  <relations>
    <relation>
      <source>A</source><target>B</target><type>AUTHORED</type>
      <description>test</description><weight>15</weight>
    </relation>
    <relation>
      <source>A</source><target>B</target><type>MODIFIED</type>
      <description>test</description><weight>-3</weight>
    </relation>
  </relations>
</extraction>`;

    const result = parseExtractionXml(xml);
    expect(result.relations[0]!.weight).toBe(10);
    expect(result.relations[1]!.weight).toBe(1);
  });

  it("skips entities with missing required fields", () => {
    const xml = `<extraction>
  <entities>
    <entity><name>Valid</name><type>PERSON</type><description>ok</description></entity>
    <entity><type>MODULE</type><description>missing name</description></entity>
    <entity><name>NoType</name><description>missing type</description></entity>
  </entities>
  <relations/>
</extraction>`;

    const result = parseExtractionXml(xml);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.name).toBe("Valid");
  });

  it("skips entities with invalid types", () => {
    const xml = `<extraction>
  <entities>
    <entity><name>Valid</name><type>PERSON</type><description>ok</description></entity>
    <entity><name>Invalid</name><type>SERVICE</type><description>not a valid type</description></entity>
    <entity><name>Also Invalid</name><type>API</type><description>nope</description></entity>
  </entities>
  <relations>
    <relation>
      <source>Valid</source><target>Invalid</target><type>AUTHORED</type>
      <description>ok</description><weight>5</weight>
    </relation>
    <relation>
      <source>Valid</source><target>Invalid</target><type>CALLS</type>
      <description>not a valid relation type</description><weight>5</weight>
    </relation>
  </relations>
</extraction>`;

    const result = parseExtractionXml(xml);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.name).toBe("Valid");
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]!.type).toBe("AUTHORED");
  });

  it("returns empty result for non-XML response", () => {
    const result = parseExtractionXml("I cannot extract any entities from this text.");
    expect(result.entities).toHaveLength(0);
    expect(result.relations).toHaveLength(0);
  });

  it("returns empty result for empty string", () => {
    const result = parseExtractionXml("");
    expect(result.entities).toHaveLength(0);
    expect(result.relations).toHaveLength(0);
  });

  it("defaults missing weight to 5", () => {
    const xml = `<extraction>
  <entities>
    <entity><name>A</name><type>PERSON</type><description>a</description></entity>
    <entity><name>B</name><type>MODULE</type><description>b</description></entity>
  </entities>
  <relations>
    <relation>
      <source>A</source><target>B</target><type>AUTHORED</type>
      <description>test</description>
    </relation>
  </relations>
</extraction>`;

    const result = parseExtractionXml(xml);
    expect(result.relations[0]!.weight).toBe(5);
  });

  it("parses XML wrapped in markdown code fences", () => {
    const text =
      "```xml\n<extraction>\n  <entities>\n    <entity>\n      <name>Test</name>\n      <type>PERSON</type>\n      <description>dev</description>\n    </entity>\n  </entities>\n  <relations/>\n</extraction>\n```";

    const result = parseExtractionXml(text);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.name).toBe("Test");
  });

  it("skips relations with wrong source/target entity types", () => {
    const xml = `<extraction>
  <entities>
    <entity><name>Alice</name><type>PERSON</type><description>dev</description></entity>
    <entity><name>React</name><type>TECHNOLOGY</type><description>lib</description></entity>
  </entities>
  <relations>
    <relation>
      <source>Alice</source><target>React</target><type>INTRODUCED</type>
      <description>Alice introduced React</description><weight>8</weight>
    </relation>
    <relation>
      <source>Alice</source><target>React</target><type>CO_CHANGED</type>
      <description>wrong types for CO_CHANGED</description><weight>5</weight>
    </relation>
  </relations>
</extraction>`;

    const result = parseExtractionXml(xml);
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]!.type).toBe("INTRODUCED");
  });

  it("allows relations when source/target entity is not in entities list", () => {
    const xml = `<extraction>
  <entities>
    <entity><name>Alice</name><type>PERSON</type><description>dev</description></entity>
  </entities>
  <relations>
    <relation>
      <source>Alice</source><target>Unknown Module</target><type>AUTHORED</type>
      <description>dangling relation</description><weight>5</weight>
    </relation>
  </relations>
</extraction>`;

    const result = parseExtractionXml(xml);
    expect(result.relations).toHaveLength(1);
  });
});

describe("extractor — stripCodeFences", () => {
  it("strips xml code fences", () => {
    expect(stripCodeFences("```xml\n<extraction>test</extraction>\n```")).toBe(
      "<extraction>test</extraction>\n",
    );
  });

  it("strips plain code fences", () => {
    expect(stripCodeFences("```\n<extraction>test</extraction>\n```")).toBe(
      "<extraction>test</extraction>\n",
    );
  });

  it("leaves text without fences unchanged", () => {
    expect(stripCodeFences("<extraction>test</extraction>")).toBe("<extraction>test</extraction>");
  });
});

describe("extractor — shouldGlean", () => {
  function makeTextUnit(commitCount: number): TextUnit {
    return {
      id: "test-tu",
      content: "test content",
      commitHashes: Array.from({ length: commitCount }, (_, i) => `hash${i}`),
      dateRange: { start: "2024-01-01", end: "2024-01-31" },
      entityIds: [],
      relationIds: [],
    };
  }

  it("returns false for small chunks (< 8 commits)", () => {
    const result = {
      entities: [{ name: "A", type: EntityType.PERSON, description: "" }],
      relations: [],
    };
    expect(shouldGlean(result, makeTextUnit(5))).toBe(false);
  });

  it("returns true for large chunks with few entities", () => {
    const result = {
      entities: [{ name: "A", type: EntityType.PERSON, description: "" }],
      relations: [],
    };
    expect(shouldGlean(result, makeTextUnit(10))).toBe(true);
  });

  it("returns false for large chunks with enough entities", () => {
    const entities = Array.from({ length: 6 }, (_, i) => ({
      name: `Entity${i}`,
      type: EntityType.PERSON,
      description: "",
    }));
    expect(shouldGlean({ entities, relations: [] }, makeTextUnit(10))).toBe(false);
  });
});
