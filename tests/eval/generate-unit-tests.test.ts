import { describe, expect, test } from "bun:test";
import {
  buildGenerationPrompt,
  generateUnitTests,
} from "../../cli/selftune/eval/generate-unit-tests.js";
import type { EvalEntry, SkillUnitTest } from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// buildGenerationPrompt — prompt construction
// ---------------------------------------------------------------------------
describe("buildGenerationPrompt", () => {
  test("includes skill name and content in prompt", () => {
    const prompt = buildGenerationPrompt("pptx", "A skill for making slides", []);
    expect(prompt).toContain("pptx");
    expect(prompt).toContain("A skill for making slides");
  });

  test("includes eval failures when provided", () => {
    const failures: EvalEntry[] = [
      { query: "make slides for Q3", should_trigger: true, invocation_type: "contextual" },
      { query: "create a deck", should_trigger: true, invocation_type: "implicit" },
    ];
    const prompt = buildGenerationPrompt("pptx", "Skill content", failures);
    expect(prompt).toContain("make slides for Q3");
    expect(prompt).toContain("create a deck");
  });

  test("includes few-shot examples", () => {
    const prompt = buildGenerationPrompt("pptx", "Skill content", []);
    expect(prompt).toContain("contains");
    expect(prompt).toContain("assertions");
  });
});

// ---------------------------------------------------------------------------
// generateUnitTests — mock LLM, verify test generation
// ---------------------------------------------------------------------------
describe("generateUnitTests", () => {
  test("generates unit tests from LLM response", async () => {
    const mockTests: SkillUnitTest[] = [
      {
        id: "gen-1",
        skill_name: "pptx",
        query: "make slides",
        assertions: [{ type: "contains", value: "slide" }],
        tags: ["generated"],
      },
      {
        id: "gen-2",
        skill_name: "pptx",
        query: "create presentation",
        assertions: [{ type: "tool_called", value: "Write" }],
        tags: ["generated"],
      },
    ];

    const mockLlm = async (_system: string, _user: string): Promise<string> =>
      JSON.stringify(mockTests);

    const result = await generateUnitTests("pptx", "A skill for making slides", [], mockLlm);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("gen-1");
    expect(result[0].skill_name).toBe("pptx");
    expect(result[1].assertions[0].type).toBe("tool_called");
  });

  test("handles LLM returning markdown-fenced JSON", async () => {
    const mockTests: SkillUnitTest[] = [
      {
        id: "gen-1",
        skill_name: "test-skill",
        query: "do something",
        assertions: [{ type: "contains", value: "done" }],
      },
    ];

    const mockLlm = async (_system: string, _user: string): Promise<string> =>
      `\`\`\`json\n${JSON.stringify(mockTests)}\n\`\`\``;

    const result = await generateUnitTests("test-skill", "Skill content", [], mockLlm);
    expect(result).toHaveLength(1);
    expect(result[0].skill_name).toBe("test-skill");
  });

  test("returns empty array when LLM returns invalid JSON", async () => {
    const mockLlm = async (_system: string, _user: string): Promise<string> =>
      "I cannot generate tests because...";

    const result = await generateUnitTests("pptx", "Skill content", [], mockLlm);
    expect(result).toEqual([]);
  });

  test("returns empty array when LLM throws", async () => {
    const mockLlm = async (_system: string, _user: string): Promise<string> => {
      throw new Error("LLM unavailable");
    };

    const result = await generateUnitTests("pptx", "Skill content", [], mockLlm);
    expect(result).toEqual([]);
  });

  test("passes eval failures to the prompt builder", async () => {
    let capturedUser = "";
    const mockLlm = async (_system: string, user: string): Promise<string> => {
      capturedUser = user;
      return "[]";
    };

    const failures: EvalEntry[] = [
      { query: "contextual fail query", should_trigger: true, invocation_type: "contextual" },
    ];

    await generateUnitTests("pptx", "Skill content", failures, mockLlm);
    expect(capturedUser).toContain("contextual fail query");
  });
});
