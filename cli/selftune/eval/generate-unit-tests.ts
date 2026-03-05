/**
 * Skill unit test generator.
 *
 * Uses an LLM to generate unit test cases from skill content and eval failures.
 * Tests are output as SkillUnitTest[] JSON arrays.
 */

import type { EvalEntry, SkillUnitTest } from "../types.js";
// Note: we don't use stripMarkdownFences from llm-call.ts because it
// assumes JSON objects (looks for `{`), but we return JSON arrays.

/** Strip markdown fences and find JSON array content. */
function stripArrayFences(raw: string): string {
  let text = raw.trim();

  // Strip markdown code fences
  const fenceMatch = text.match(/^```\w*\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // Find first [ in case there's preamble text
  const bracketIdx = text.indexOf("[");
  if (bracketIdx >= 0) {
    text = text.slice(bracketIdx);
  }

  return text;
}

// ---------------------------------------------------------------------------
// LLM caller type (injectable for testing)
// ---------------------------------------------------------------------------

export type LlmCaller = (systemPrompt: string, userPrompt: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a test engineer generating skill unit tests.
Given a skill name, its content/description, and optionally some eval failures,
generate unit test cases as a JSON array of objects.

Each test object must have:
- id: unique string (e.g. "gen-1", "gen-2")
- skill_name: the skill name provided
- query: a user query that would test this skill
- assertions: array of assertion objects, each with:
  - type: one of "contains", "not_contains", "regex", "tool_called", "tool_not_called", "json_path"
  - value: the value to check for
  - description: (optional) human-readable description of what this checks
- tags: (optional) array of tag strings like ["generated", "smoke"]

Focus on:
1. Covering different invocation patterns (explicit, implicit, contextual)
2. Testing edge cases from eval failures if provided
3. Verifying expected tools are called
4. Checking output contains expected content

Respond with ONLY a JSON array. No explanation.`;

/** Build the user prompt for test generation. */
export function buildGenerationPrompt(
  skillName: string,
  skillContent: string,
  evalFailures: EvalEntry[],
): string {
  const parts: string[] = [
    `Skill name: ${skillName}`,
    "",
    "Skill content:",
    skillContent,
    "",
  ];

  if (evalFailures.length > 0) {
    parts.push("Eval failures (queries that failed trigger checks):");
    for (const f of evalFailures) {
      parts.push(
        `  - query: "${f.query}" (should_trigger=${f.should_trigger}, type=${f.invocation_type ?? "unknown"})`,
      );
    }
    parts.push("");
  }

  parts.push("Example test case format:");
  parts.push(
    JSON.stringify(
      [
        {
          id: "example-1",
          skill_name: skillName,
          query: "example query for this skill",
          assertions: [
            { type: "contains", value: "expected output", description: "checks for expected content" },
            { type: "tool_called", value: "Write", description: "verifies Write tool was used" },
          ],
          tags: ["generated"],
        },
      ],
      null,
      2,
    ),
  );

  parts.push("");
  parts.push("Generate 5-10 diverse test cases covering the skill's functionality.");

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Generate unit tests
// ---------------------------------------------------------------------------

/** Generate unit tests for a skill using an LLM. Returns empty array on error. */
export async function generateUnitTests(
  skillName: string,
  skillContent: string,
  evalFailures: EvalEntry[],
  llmCaller: LlmCaller,
): Promise<SkillUnitTest[]> {
  try {
    const userPrompt = buildGenerationPrompt(skillName, skillContent, evalFailures);
    const raw = await llmCaller(SYSTEM_PROMPT, userPrompt);
    const cleaned = stripArrayFences(raw);

    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      console.warn(JSON.stringify({ level: "warn", msg: "LLM did not return a JSON array for unit test generation" }));
      return [];
    }

    // Validate and filter to well-shaped entries
    return parsed
      .filter((t: unknown): t is Record<string, unknown> =>
        typeof t === "object" && t !== null &&
        typeof (t as Record<string, unknown>).id === "string" &&
        typeof (t as Record<string, unknown>).query === "string" &&
        Array.isArray((t as Record<string, unknown>).assertions),
      )
      .map((t) => ({
        id: t.id as string,
        skill_name: (typeof t.skill_name === "string" ? t.skill_name : skillName) as string,
        query: t.query as string,
        assertions: t.assertions as SkillUnitTest["assertions"],
        ...(t.timeout_ms != null ? { timeout_ms: t.timeout_ms as number } : {}),
        ...(Array.isArray(t.tags) ? { tags: t.tags as string[] } : {}),
      }));
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", msg: "Failed to generate unit tests", error: String(err) }));
    return [];
  }
}
