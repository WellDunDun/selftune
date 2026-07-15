import { describe, expect, test } from "bun:test";

import { cliMain as runAutoActivate } from "@selftune/harness-claude-code/hooks/auto-activate";
import { cliMain as runCommitTrack } from "@selftune/harness-claude-code/hooks/commit-track";
import { cliMain as runEvolutionGuard } from "@selftune/harness-claude-code/hooks/evolution-guard";
import { cliMain as runPromptLog } from "@selftune/harness-claude-code/hooks/prompt-log";
import { cliMain as runSessionStop } from "@selftune/harness-claude-code/hooks/session-stop";
import { cliMain as runSkillChangeGuard } from "@selftune/harness-claude-code/hooks/skill-change-guard";
import { cliMain as runSkillEval } from "@selftune/harness-claude-code/hooks/skill-eval";

describe("in-process hook entry points", () => {
  test("all packaged hook runners fail open on malformed input", async () => {
    const malformed = "not-json";
    const exitCodes = await Promise.all([
      runPromptLog(malformed),
      runSessionStop(malformed),
      runSkillEval(malformed),
      runAutoActivate(malformed),
      runSkillChangeGuard(malformed),
      runEvolutionGuard(malformed),
      runCommitTrack(malformed),
    ]);

    expect(exitCodes).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});
