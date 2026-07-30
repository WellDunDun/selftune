import { describe, expect, test } from "bun:test";

import { getInternalPromptTargetSkill } from "@selftune/runtime/utils/skill-detection";

describe("getInternalPromptTargetSkill", () => {
  test("rejects an unknown code-looking target from transcript content", () => {
    const result = getInternalPromptTargetSkill(
      [
        "You are a skill description optimizer for an AI agent routing system.",
        "Skill Name: \\s*([^\\n]+)/i,",
      ].join("\n"),
      ["effect-ts", "selftune"],
    );

    expect(result).toBeNull();
  });

  test("returns the canonical known identity for a mixed-case target", () => {
    const result = getInternalPromptTargetSkill(
      ["You are an evaluation assistant.", "Skill Name: EFFECT-TS"].join("\n"),
      ["effect-ts", "selftune"],
    );

    expect(result).toBe("effect-ts");
  });
});
