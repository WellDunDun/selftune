import { describe, expect, test } from "bun:test";
import {
  buildSyntheticPrompt,
  parseSyntheticResponse,
} from "../../cli/selftune/eval/synthetic-evals.js";

// ---------------------------------------------------------------------------
// buildSyntheticPrompt
// ---------------------------------------------------------------------------
describe("buildSyntheticPrompt", () => {
  test("includes skill name in system prompt", () => {
    const { system } = buildSyntheticPrompt("# My Skill\nDoes stuff", "my-skill", 10, 5);
    expect(system).toContain("$my-skill");
  });

  test("includes skill content in user prompt", () => {
    const content = "# PPTX Builder\nCreates PowerPoint slides from markdown.";
    const { user } = buildSyntheticPrompt(content, "pptx", 10, 5);
    expect(user).toContain(content);
    expect(user).toContain("pptx");
  });

  test("includes requested counts in user prompt", () => {
    const { user } = buildSyntheticPrompt("content", "test-skill", 15, 10);
    expect(user).toContain("15 positive");
    expect(user).toContain("10 negative");
  });

  test("system prompt mentions all invocation types", () => {
    const { system } = buildSyntheticPrompt("content", "skill", 5, 5);
    expect(system).toContain("Explicit");
    expect(system).toContain("Implicit");
    expect(system).toContain("Contextual");
  });
});

// ---------------------------------------------------------------------------
// parseSyntheticResponse — well-formed JSON
// ---------------------------------------------------------------------------
describe("parseSyntheticResponse", () => {
  test("parses clean JSON array", () => {
    const raw = JSON.stringify([
      { query: "use $pptx to make slides", should_trigger: true, invocation_type: "explicit" },
      { query: "create a deck", should_trigger: true, invocation_type: "implicit" },
      { query: "what is the weather?", should_trigger: false, invocation_type: "negative" },
    ]);
    const result = parseSyntheticResponse(raw, "pptx");
    expect(result.length).toBe(3);
    expect(result[0].should_trigger).toBe(true);
    expect(result[2].should_trigger).toBe(false);
    expect(result[2].invocation_type).toBe("negative");
  });

  test("strips markdown fences before parsing", () => {
    const raw = '```json\n[{"query":"make slides","should_trigger":true}]\n```';
    const result = parseSyntheticResponse(raw, "pptx");
    expect(result.length).toBe(1);
    expect(result[0].query).toBe("make slides");
  });

  test("handles preamble text before JSON array", () => {
    const raw = 'Here are the queries:\n[{"query":"slides please","should_trigger":true}]';
    const result = parseSyntheticResponse(raw, "pptx");
    expect(result.length).toBe(1);
  });

  test("handles trailing text after JSON array", () => {
    const raw = '[{"query":"make slides","should_trigger":true}]\n\nHope this helps!';
    const result = parseSyntheticResponse(raw, "pptx");
    expect(result.length).toBe(1);
  });

  test("skips entries with missing query field", () => {
    const raw = JSON.stringify([
      { query: "valid query", should_trigger: true },
      { should_trigger: true }, // missing query
      { query: "another valid", should_trigger: false },
    ]);
    const result = parseSyntheticResponse(raw, "pptx");
    expect(result.length).toBe(2);
  });

  test("skips entries with non-boolean should_trigger", () => {
    const raw = JSON.stringify([
      { query: "valid query", should_trigger: true },
      { query: "bad trigger", should_trigger: "yes" },
    ]);
    const result = parseSyntheticResponse(raw, "pptx");
    expect(result.length).toBe(1);
  });

  test("skips entries with empty query after trimming", () => {
    const raw = JSON.stringify([
      { query: "   ", should_trigger: true },
      { query: "real query", should_trigger: true },
    ]);
    const result = parseSyntheticResponse(raw, "pptx");
    expect(result.length).toBe(1);
    expect(result[0].query).toBe("real query");
  });

  test("throws on completely invalid JSON", () => {
    expect(() => parseSyntheticResponse("not json at all", "pptx")).toThrow(/Failed to parse/);
  });

  test("returns empty array when response is JSON object wrapping an empty array", () => {
    const raw = '{"queries": []}';
    const result = parseSyntheticResponse(raw, "pptx");
    expect(result).toEqual([]);
  });

  test("throws when response has no array at all", () => {
    const raw = '{"queries": "none"}';
    expect(() => parseSyntheticResponse(raw, "pptx")).toThrow(/Failed to parse/);
  });
});

// ---------------------------------------------------------------------------
// parseSyntheticResponse — invocation type classification
// ---------------------------------------------------------------------------
describe("parseSyntheticResponse invocation classification", () => {
  test("overrides LLM type with classifyInvocation for positives", () => {
    // LLM says "implicit" but query contains skill name → should be "explicit"
    const raw = JSON.stringify([
      { query: "use pptx to make slides", should_trigger: true, invocation_type: "implicit" },
    ]);
    const result = parseSyntheticResponse(raw, "pptx");
    expect(result[0].invocation_type).toBe("explicit");
  });

  test("classifies implicit positives correctly", () => {
    const raw = JSON.stringify([
      { query: "make a slide deck", should_trigger: true, invocation_type: "explicit" },
    ]);
    const result = parseSyntheticResponse(raw, "pptx");
    // "make a slide deck" doesn't mention "pptx" and is short → implicit
    expect(result[0].invocation_type).toBe("implicit");
  });

  test("always sets negative invocation_type for negatives", () => {
    const raw = JSON.stringify([
      { query: "what is the weather?", should_trigger: false, invocation_type: "contextual" },
    ]);
    const result = parseSyntheticResponse(raw, "pptx");
    expect(result[0].invocation_type).toBe("negative");
  });

  test("classifies contextual queries with proper nouns", () => {
    const raw = JSON.stringify([
      {
        query: "For the TechCorp board meeting create a presentation about Q4 results",
        should_trigger: true,
        invocation_type: "implicit",
      },
    ]);
    const result = parseSyntheticResponse(raw, "pptx");
    expect(result[0].invocation_type).toBe("contextual");
  });
});
