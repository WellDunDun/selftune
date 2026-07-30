import { describe, expect, it } from "vitest";

import { parseFrontmatter } from "./EvidenceViewer";

describe("parseFrontmatter", () => {
  it("parses CRLF frontmatter without changing metadata or body", () => {
    expect(
      parseFrontmatter("---\r\nname: Example\r\ndescription: includes: colon\r\n---\r\n# Body"),
    ).toEqual({
      meta: {
        name: "Example",
        description: "includes: colon",
      },
      body: "# Body",
    });
  });

  it("scans adversarial close-looking lines without accepting them as delimiters", () => {
    const closeLookingLines = "---not-a-delimiter\n".repeat(20_000);
    const text = `---\nname: Example\n${closeLookingLines}---\n# Body`;

    expect(parseFrontmatter(text)).toEqual({
      meta: { name: "Example" },
      body: "# Body",
    });
  });

  it("leaves unterminated frontmatter unchanged", () => {
    const text = `---\nname: Example\n${"---not-a-delimiter\n".repeat(20_000)}`;

    expect(parseFrontmatter(text)).toEqual({ meta: {}, body: text });
  });

  it("consumes whitespace-only lines after the closing delimiter but preserves body indentation", () => {
    expect(parseFrontmatter("---\nname: Example\n---\n \t\n\r\n  Body")).toEqual({
      meta: { name: "Example" },
      body: "  Body",
    });
  });

  it("preserves greedy opening-delimiter whitespace before close-looking metadata", () => {
    expect(parseFrontmatter("---\n\n---\nname: value\n---\n")).toEqual({
      meta: { name: "value" },
      body: "",
    });
  });

  it("backtracks opening whitespace when its greedy choice leaves no later closing delimiter", () => {
    expect(parseFrontmatter("---\n\n---\nbody")).toEqual({
      meta: {},
      body: "body",
    });
  });
});
