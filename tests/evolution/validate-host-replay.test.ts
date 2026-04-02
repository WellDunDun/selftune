import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRoutingReplayFixture,
  runClaudeRuntimeReplayFixture,
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
      mkdirSync(join(rootDir, ".git"), { recursive: true });
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

      const before = runHostReplayFixture({
        routing: "| Trigger | Workflow |\n| --- | --- |\n| make slides | present |",
        evalSet,
        fixture,
      });
      const after = runHostReplayFixture({
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

      const [result] = runHostReplayFixture({
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

  test("ignores malformed rows with empty trigger cells", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Prepare quarterly briefings for leadership reviews.",
        ["Leadership review briefings and quarterly update packets"],
      );
      const fixture = makeFixture(targetPath);

      const [result] = runHostReplayFixture({
        routing: "| Trigger | Workflow |\n| --- | --- |\n| | present |",
        evalSet: [{ query: "present", should_trigger: false }],
        fixture,
      });

      expect(result?.triggered).toBe(false);
      expect(result?.passed).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("falls back to empty/default surfaces when the target skill file is missing", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const missingTargetPath = join(rootDir, "missing-skill", "SKILL.md");
      const fixture = makeFixture(missingTargetPath);

      const [result] = runHostReplayFixture({
        routing: "| Trigger | Workflow |\n| --- | --- |\n| quarterly briefing | present |",
        evalSet: [{ query: "create deck for the board meeting", should_trigger: true }],
        fixture,
      });

      expect(result).toBeDefined();
      expect(result?.triggered).toBe(false);
      expect(result?.passed).toBe(false);
      expect(result?.evidence).toContain("did not clear replay threshold");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("uses claude runtime replay when a runtime invoker is provided", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Create decks and slide presentations.",
        ["Presentation building requests"],
      );
      const comparePath = writeSkill(rootDir, "compare-skill", "Compare options side by side.", [
        "Comparison and trade-off requests",
      ]);
      const fixture = makeFixture(targetPath, [comparePath]);

      const results = await runClaudeRuntimeReplayFixture({
        routing: "| Trigger | Workflow |\n| --- | --- |\n| create deck, board deck | present |",
        evalSet: [
          { query: "create a board deck", should_trigger: true },
          { query: "compare stripe and paddle", should_trigger: false },
        ],
        fixture,
        runtimeInvoker: async (input) => {
          expect(input.workspaceRoot).toContain("selftune-runtime-replay-");
          expect(readFileSync(input.targetSkillPath, "utf8")).toContain("create deck, board deck");
          if (input.query.includes("board deck")) {
            return {
              invokedSkillNames: ["deck-skill"],
              readSkillPaths: [input.targetSkillPath],
              rawOutput: "",
              sessionId: "runtime-session-1",
            };
          }
          return {
            invokedSkillNames: ["compare-skill"],
            readSkillPaths: input.competingSkillPaths,
            rawOutput: "",
            sessionId: "runtime-session-2",
          };
        },
      });

      expect(results[0]?.triggered).toBe(true);
      expect(results[0]?.passed).toBe(true);
      expect(results[0]?.evidence).toContain("runtime replay session runtime-session-1");
      expect(results[1]?.triggered).toBe(false);
      expect(results[1]?.passed).toBe(true);
      expect(results[1]?.evidence).toContain("competing skill");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("falls back to fixture simulation when claude runtime replay fails", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Create decks and slide presentations.",
        ["Presentation building requests"],
      );
      const fixture = makeFixture(targetPath);

      const [result] = await runClaudeRuntimeReplayFixture({
        routing: "| Trigger | Workflow |\n| --- | --- |\n| create deck, board deck | present |",
        evalSet: [{ query: "create a board deck", should_trigger: true }],
        fixture,
        runtimeInvoker: async () => {
          throw new Error("claude not available");
        },
      });

      expect(result?.triggered).toBe(true);
      expect(result?.passed).toBe(true);
      expect(result?.evidence).toContain("fell back to fixture simulation");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("falls back to fixture simulation when runtime replay returns an error state", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Create decks and slide presentations.",
        ["Presentation building requests"],
      );
      const fixture = makeFixture(targetPath);

      const [result] = await runClaudeRuntimeReplayFixture({
        routing: "| Trigger | Workflow |\n| --- | --- |\n| create deck, board deck | present |",
        evalSet: [{ query: "create a board deck", should_trigger: true }],
        fixture,
        runtimeInvoker: async () => ({
          invokedSkillNames: [],
          readSkillPaths: [],
          rawOutput: "",
          sessionId: "runtime-session-error",
          runtimeError: "tool call timed out",
        }),
      });

      expect(result?.triggered).toBe(true);
      expect(result?.passed).toBe(true);
      expect(result?.evidence).toContain("fell back to fixture simulation");
      expect(result?.evidence).toContain("runtime replay session runtime-session-error");
      expect(result?.evidence).toContain("tool call timed out");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("treats target read without invocation as a failed positive", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Create decks and slide presentations.",
        ["Presentation building requests"],
      );
      const fixture = makeFixture(targetPath);

      const [result] = await runClaudeRuntimeReplayFixture({
        routing: "| Trigger | Workflow |\n| --- | --- |\n| create deck, board deck | present |",
        evalSet: [{ query: "create a board deck", should_trigger: true }],
        fixture,
        runtimeInvoker: async (input) => ({
          invokedSkillNames: [],
          readSkillPaths: [input.targetSkillPath],
          rawOutput: "",
          sessionId: "runtime-session-read-only",
        }),
      });

      expect(result?.triggered).toBe(false);
      expect(result?.passed).toBe(false);
      expect(result?.evidence).toContain("only read the target skill without invoking it");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("treats no routing decision as a successful negative", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Create decks and slide presentations.",
        ["Presentation building requests"],
      );
      const fixture = makeFixture(targetPath);

      const [result] = await runClaudeRuntimeReplayFixture({
        routing: "| Trigger | Workflow |\n| --- | --- |\n| create deck, board deck | present |",
        evalSet: [{ query: "what's the weather in amman", should_trigger: false }],
        fixture,
        runtimeInvoker: async () => ({
          invokedSkillNames: [],
          readSkillPaths: [],
          rawOutput: "",
          sessionId: "runtime-session-none",
        }),
      });

      expect(result?.triggered).toBe(false);
      expect(result?.passed).toBe(true);
      expect(result?.evidence).toContain("did not invoke any local project skill");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("treats unrelated skill invocation as a failed positive", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Create decks and slide presentations.",
        ["Presentation building requests"],
      );
      const fixture = makeFixture(targetPath);

      const [result] = await runClaudeRuntimeReplayFixture({
        routing: "| Trigger | Workflow |\n| --- | --- |\n| create deck, board deck | present |",
        evalSet: [{ query: "create a board deck", should_trigger: true }],
        fixture,
        runtimeInvoker: async () => ({
          invokedSkillNames: ["browser"],
          readSkillPaths: [],
          rawOutput: "",
          sessionId: "runtime-session-unrelated",
        }),
      });

      expect(result?.triggered).toBe(false);
      expect(result?.passed).toBe(false);
      expect(result?.evidence).toContain("invoked unrelated skill: browser");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("treats unrelated skill invocation as a failed negative", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Create decks and slide presentations.",
        ["Presentation building requests"],
      );
      const fixture = makeFixture(targetPath);

      const [result] = await runClaudeRuntimeReplayFixture({
        routing: "| Trigger | Workflow |\n| --- | --- |\n| create deck, board deck | present |",
        evalSet: [{ query: "what's the weather in amman", should_trigger: false }],
        fixture,
        runtimeInvoker: async () => ({
          invokedSkillNames: ["browser"],
          readSkillPaths: [],
          rawOutput: "",
          sessionId: "runtime-session-unrelated-negative",
        }),
      });

      expect(result?.triggered).toBe(false);
      expect(result?.passed).toBe(false);
      expect(result?.evidence).toContain("invoked unrelated skill: browser");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("treats multiple invoked skills as an ambiguous failure", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Create decks and slide presentations.",
        ["Presentation building requests"],
      );
      const comparePath = writeSkill(rootDir, "compare-skill", "Compare options side by side.", [
        "Comparison and trade-off requests",
      ]);
      const fixture = makeFixture(targetPath, [comparePath]);

      const [result] = await runClaudeRuntimeReplayFixture({
        routing: "| Trigger | Workflow |\n| --- | --- |\n| create deck, board deck | present |",
        evalSet: [{ query: "create a board deck", should_trigger: true }],
        fixture,
        runtimeInvoker: async () => ({
          invokedSkillNames: ["deck-skill", "compare-skill"],
          readSkillPaths: [],
          rawOutput: "",
          sessionId: "runtime-session-ambiguous",
        }),
      });

      expect(result?.triggered).toBe(false);
      expect(result?.passed).toBe(false);
      expect(result?.evidence).toContain("invoked multiple skills: deck-skill, compare-skill");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
