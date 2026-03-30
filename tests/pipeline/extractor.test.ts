import { describe, it, expect } from "vitest";
import { parseExtractionXml } from "../../src/pipeline/extractor.js";

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
});
