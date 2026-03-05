/**
 * Tests for cli/selftune/utils/trigger-check.ts
 *
 * Verifies that the extracted trigger-check functions work correctly
 * when imported from the shared utility module.
 */

import { describe, expect, test } from "bun:test";
import {
  buildTriggerCheckPrompt,
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
