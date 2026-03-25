/**
 * Tests for cli/selftune/utils/trigger-check.ts
 *
 * Verifies that the extracted trigger-check functions work correctly
 * when imported from the shared utility module.
 */

import { describe, expect, test } from "bun:test";

import {
  buildBatchTriggerCheckPrompt,
  buildTriggerCheckPrompt,
  parseBatchTriggerResponse,
  parseTriggerResponse,
} from "../../cli/selftune/utils/trigger-check.js";

// ---------------------------------------------------------------------------
// buildTriggerCheckPrompt
// ---------------------------------------------------------------------------

describe("buildTriggerCheckPrompt", () => {
  test("includes the description in the prompt", () => {
    const prompt = buildTriggerCheckPrompt("My skill description", "user query here");
    expect(prompt).toContain("My skill description");
  });

  test("includes the query in the prompt", () => {
    const prompt = buildTriggerCheckPrompt("My skill description", "user query here");
    expect(prompt).toContain("user query here");
  });

  test("asks for YES or NO response", () => {
    const prompt = buildTriggerCheckPrompt("desc", "query");
    const upper = prompt.toUpperCase();
    expect(upper).toContain("YES");
    expect(upper).toContain("NO");
  });

  test("mentions skill description context", () => {
    const prompt = buildTriggerCheckPrompt("desc", "query");
    expect(prompt).toContain("Skill description:");
  });

  test("mentions user query context", () => {
    const prompt = buildTriggerCheckPrompt("desc", "query");
    expect(prompt).toContain("User query:");
  });
});

// ---------------------------------------------------------------------------
// parseTriggerResponse
// ---------------------------------------------------------------------------

describe("parseTriggerResponse", () => {
  test("'YES' returns true", () => {
    expect(parseTriggerResponse("YES")).toBe(true);
  });

  test("'NO' returns false", () => {
    expect(parseTriggerResponse("NO")).toBe(false);
  });

  test("'Yes, because...' returns true (starts with YES)", () => {
    expect(parseTriggerResponse("Yes, because the query matches")).toBe(true);
  });

  test("'yes' lowercase returns true", () => {
    expect(parseTriggerResponse("yes")).toBe(true);
  });

  test("'no' lowercase returns false", () => {
    expect(parseTriggerResponse("no")).toBe(false);
  });

  test("empty string returns false (conservative default)", () => {
    expect(parseTriggerResponse("")).toBe(false);
  });

  test("'maybe' returns false (not YES or NO)", () => {
    expect(parseTriggerResponse("maybe")).toBe(false);
  });

  test("whitespace-padded '  YES  ' returns true", () => {
    expect(parseTriggerResponse("  YES  ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildBatchTriggerCheckPrompt
// ---------------------------------------------------------------------------

describe("buildBatchTriggerCheckPrompt", () => {
  test("includes skill description", () => {
    const prompt = buildBatchTriggerCheckPrompt("My skill", ["query one", "query two"]);
    expect(prompt).toContain("My skill");
  });

  test("includes numbered queries", () => {
    const prompt = buildBatchTriggerCheckPrompt("desc", ["alpha", "beta", "gamma"]);
    expect(prompt).toContain('1. "alpha"');
    expect(prompt).toContain('2. "beta"');
    expect(prompt).toContain('3. "gamma"');
  });

  test("asks for YES or NO per query", () => {
    const prompt = buildBatchTriggerCheckPrompt("desc", ["q1"]);
    expect(prompt).toContain("YES or NO");
  });

  test("mentions Skill description header", () => {
    const prompt = buildBatchTriggerCheckPrompt("desc", ["q1"]);
    expect(prompt).toContain("Skill description:");
  });

  test("mentions Queries header", () => {
    const prompt = buildBatchTriggerCheckPrompt("desc", ["q1"]);
    expect(prompt).toContain("Queries:");
  });
});

// ---------------------------------------------------------------------------
// parseBatchTriggerResponse
// ---------------------------------------------------------------------------

describe("parseBatchTriggerResponse", () => {
  test("parses standard '1. YES' format", () => {
    const response = "1. YES\n2. NO\n3. YES";
    expect(parseBatchTriggerResponse(response, 3)).toEqual([true, false, true]);
  });

  test("parses '1: YES' colon format", () => {
    const response = "1: YES\n2: NO";
    expect(parseBatchTriggerResponse(response, 2)).toEqual([true, false]);
  });

  test("parses '1 YES' space format", () => {
    const response = "1 YES\n2 NO";
    expect(parseBatchTriggerResponse(response, 2)).toEqual([true, false]);
  });

  test("parses '1) YES' paren format", () => {
    const response = "1) YES\n2) NO";
    expect(parseBatchTriggerResponse(response, 2)).toEqual([true, false]);
  });

  test("handles extra text after YES/NO", () => {
    const response = "1. YES - this matches the skill\n2. NO - not relevant";
    expect(parseBatchTriggerResponse(response, 2)).toEqual([true, false]);
  });

  test("defaults missing responses to false", () => {
    const response = "1. YES\n3. YES";
    expect(parseBatchTriggerResponse(response, 4)).toEqual([true, false, true, false]);
  });

  test("handles empty response", () => {
    expect(parseBatchTriggerResponse("", 3)).toEqual([false, false, false]);
  });

  test("ignores out-of-range numbers", () => {
    const response = "0. YES\n1. YES\n5. YES";
    expect(parseBatchTriggerResponse(response, 2)).toEqual([true, false]);
  });

  test("handles case insensitive YES/NO", () => {
    const response = "1. yes\n2. No";
    expect(parseBatchTriggerResponse(response, 2)).toEqual([true, false]);
  });

  test("returns all false for garbage input", () => {
    const response = "I'm not sure about these queries";
    expect(parseBatchTriggerResponse(response, 3)).toEqual([false, false, false]);
  });
});

// ---------------------------------------------------------------------------
// Re-export from validate-proposal still works
// ---------------------------------------------------------------------------

describe("re-export from validate-proposal", () => {
  test("validate-proposal re-exports buildTriggerCheckPrompt", async () => {
    const mod = await import("../../cli/selftune/evolution/validate-proposal.js");
    expect(typeof mod.buildTriggerCheckPrompt).toBe("function");
  });

  test("validate-proposal re-exports parseTriggerResponse", async () => {
    const mod = await import("../../cli/selftune/evolution/validate-proposal.js");
    expect(typeof mod.parseTriggerResponse).toBe("function");
  });
});
