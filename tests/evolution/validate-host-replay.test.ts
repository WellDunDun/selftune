import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRoutingReplayFixture,
  runHostReplayFixture,
} from "../../cli/selftune/evolution/validate-host-replay.js";
import type { EvalEntry, RoutingReplayFixture } from "../../cli/selftune/types.js";

function writeSkill(
  rootDir: string,
  skillName: string,
  description: string,
  whenToUse: string[],
): string {
  const skillDir = join(rootDir, skillName);
  mkdirSync(skillDir, { recursive: true });
  const path = join(skillDir, "SKILL.md");
  writeFileSync(
    path,
    `---
name: ${skillName}
description: ${description}
---

# ${skillName}

## When to Use

${whenToUse.map((line) => `- ${line}`).join("\n")}
`,
  );
  return path;
}

function makeFixture(targetPath: string, competingSkillPaths: string[] = []): RoutingReplayFixture {
  return {
    fixture_id: "fixture-routing-claude",
    platform: "claude_code",
    target_skill_name: "deck-skill",
    target_skill_path: targetPath,
    competing_skill_paths: competingSkillPaths,
  };
}

describe("runHostReplayFixture", () => {
  test("builds an auto fixture from the target skill registry", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      writeFileSync(join(rootDir, ".git"), "");
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Prepare quarterly briefings for leadership reviews.",
        ["Leadership review briefings and quarterly update packets"],
      );
      const comparePath = writeSkill(
        rootDir,
        "compare-skill",
        "Compare options side by side for trade-off decisions.",
        ["Comparison and trade-off requests"],
      );

      const fixture = buildRoutingReplayFixture({
        skillName: "deck-skill",
        skillPath: targetPath,
      });

      expect(fixture.fixture_id).toBe("auto-claude_code-deck-skill");
      expect(fixture.target_skill_path).toBe(realpathSync(targetPath));
      expect(fixture.competing_skill_paths).toEqual([realpathSync(comparePath)]);
      expect(fixture.workspace_root).toBe(realpathSync(rootDir));
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("uses routing phrases to improve positive trigger outcomes", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Prepare quarterly briefings for leadership reviews.",
        ["Leadership review briefings and quarterly update packets"],
      );
      const fixture = makeFixture(targetPath);
      const evalSet: EvalEntry[] = [
        { query: "create deck for board meeting", should_trigger: true },
      ];

      const before = await runHostReplayFixture({
        routing: "| Trigger | Workflow |\n| --- | --- |\n| make slides | present |",
        evalSet,
        fixture,
      });
      const after = await runHostReplayFixture({
        routing:
          "| Trigger | Workflow |\n| --- | --- |\n| make slides, create deck, board deck | present |",
        evalSet,
        fixture,
      });

      expect(before[0]?.passed).toBe(false);
      expect(after[0]?.passed).toBe(true);
      expect(after[0]?.evidence).toContain("routing");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("suppresses target trigger when a competing skill is explicitly named", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Create decks and slide presentations.",
        ["Presentation building requests"],
      );
      const comparePath = writeSkill(
        rootDir,
        "compare-skill",
        "Compare two options side by side.",
        ["Comparison and trade-off requests"],
      );
      const fixture = makeFixture(targetPath, [comparePath]);

      const [result] = await runHostReplayFixture({
        routing: "| Trigger | Workflow |\n| --- | --- |\n| create deck, presentation | present |",
        evalSet: [{ query: "use compare-skill to weigh stripe vs paddle", should_trigger: false }],
        fixture,
      });

      expect(result?.triggered).toBe(false);
      expect(result?.passed).toBe(true);
      expect(result?.evidence).toContain("explicit competing skill mention");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
