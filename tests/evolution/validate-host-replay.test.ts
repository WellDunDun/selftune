import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildRoutingReplayFixture,
  extractClaudeRuntimeReplayMetrics,
  parseCodexRuntimeReplayOutput,
  parseOpenCodeRuntimeReplayOutput,
  runHostRuntimeReplayFixture,
  runClaudeRuntimeReplayFixture,
  runHostReplayFixture,
} from "../../cli/selftune/evolution/validate-host-replay.js";
import { setCurrentDashboardActionContext } from "../../cli/selftune/dashboard-action-events.js";
import type { DashboardActionEvent } from "../../cli/selftune/dashboard-contract.js";
import type { EvalEntry, RoutingReplayFixture } from "../../cli/selftune/types.js";
import { readJsonl } from "../../cli/selftune/utils/jsonl.js";

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
  test("extracts Claude stream-json metrics for live replay dashboards", () => {
    expect(
      extractClaudeRuntimeReplayMetrics(
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "session-1",
          model: "claude-opus-4-6[1m]",
        }),
      ),
    ).toEqual({
      platform: "claude_code",
      model: "claude-opus-4-6",
      session_id: "session-1",
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      total_cost_usd: null,
      duration_ms: null,
      num_turns: null,
    });

    expect(
      extractClaudeRuntimeReplayMetrics(
        JSON.stringify({
          type: "assistant",
          session_id: "session-1",
          message: {
            model: "claude-opus-4-6",
            usage: {
              input_tokens: 3,
              output_tokens: 1,
              cache_creation_input_tokens: 11,
              cache_read_input_tokens: 22,
            },
          },
        }),
      ),
    ).toEqual({
      platform: "claude_code",
      model: "claude-opus-4-6",
      session_id: "session-1",
      input_tokens: 3,
      output_tokens: 1,
      cache_creation_input_tokens: 11,
      cache_read_input_tokens: 22,
      total_cost_usd: null,
      duration_ms: null,
      num_turns: null,
    });

    expect(
      extractClaudeRuntimeReplayMetrics(
        JSON.stringify({
          type: "result",
          session_id: "session-1",
          duration_ms: 14621,
          total_cost_usd: 0.08946875,
          num_turns: 1,
          usage: {
            input_tokens: 3,
            output_tokens: 4,
            cache_creation_input_tokens: 13225,
            cache_read_input_tokens: 13395,
          },
          modelUsage: {
            "claude-opus-4-6[1m]": {
              inputTokens: 3,
            },
          },
        }),
      ),
    ).toEqual({
      platform: "claude_code",
      model: "claude-opus-4-6",
      session_id: "session-1",
      input_tokens: 3,
      output_tokens: 4,
      cache_creation_input_tokens: 13225,
      cache_read_input_tokens: 13395,
      total_cost_usd: 0.08946875,
      duration_ms: 14621,
      num_turns: 1,
    });
  });

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
        evalSet: [
          {
            query: "use compare-skill to weigh stripe vs paddle",
            should_trigger: false,
          },
        ],
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
              triggeredSkillNames: ["deck-skill"],
              readSkillPaths: [input.targetSkillPath],
              rawOutput: "",
              sessionId: "runtime-session-1",
            };
          }
          return {
            triggeredSkillNames: ["compare-skill"],
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

  test("emits per-eval progress events during runtime replay", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    const actionLogPath = join(rootDir, "dashboard-action-events.jsonl");
    process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = actionLogPath;
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Create decks and slide presentations.",
        ["Presentation building requests"],
      );
      const fixture = makeFixture(targetPath);

      setCurrentDashboardActionContext({
        eventId: "evt-progress",
        action: "replay-dry-run",
        skillName: "deck-skill",
        skillPath: targetPath,
      });

      await runHostRuntimeReplayFixture({
        routing: "| Trigger | Workflow |\n| --- | --- |\n| create deck, board deck | present |",
        evalSet: [
          { query: "create a board deck", should_trigger: true },
          { query: "compare stripe and paddle", should_trigger: false },
        ],
        fixture,
        runtimeInvoker: async (input) => {
          if (input.query.includes("board deck")) {
            return {
              triggeredSkillNames: ["deck-skill"],
              readSkillPaths: [input.targetSkillPath],
              rawOutput: "",
              sessionId: "runtime-session-1",
            };
          }
          return {
            triggeredSkillNames: [],
            readSkillPaths: [],
            rawOutput: "",
            sessionId: "runtime-session-2",
          };
        },
      });

      const progressEvents = readJsonl<DashboardActionEvent>(actionLogPath).filter(
        (event) => event.stage === "progress",
      );
      expect(progressEvents).toHaveLength(4);
      expect(progressEvents[0]?.progress).toEqual({
        current: 1,
        total: 2,
        status: "started",
        query: "create a board deck",
        passed: null,
        evidence: null,
      });
      expect(progressEvents[1]?.progress?.status).toBe("finished");
      expect(progressEvents[1]?.progress?.passed).toBe(true);
      expect(progressEvents[2]?.progress).toEqual({
        current: 2,
        total: 2,
        status: "started",
        query: "compare stripe and paddle",
        passed: null,
        evidence: null,
      });
      expect(progressEvents[3]?.progress?.status).toBe("finished");
      expect(progressEvents[3]?.progress?.passed).toBe(true);
    } finally {
      setCurrentDashboardActionContext(null);
      delete process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG;
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("stages description-only content for runtime replay when requested", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Create decks and slide presentations.",
        ["Presentation building requests"],
      );
      const fixture = makeFixture(targetPath);
      const newDescription = "Handle investor decks and board-ready presentation requests.";

      const [result] = await runClaudeRuntimeReplayFixture({
        routing: newDescription,
        contentTarget: "description",
        evalSet: [{ query: "create a board deck", should_trigger: true }],
        fixture,
        runtimeInvoker: async (input) => {
          const stagedContent = readFileSync(input.targetSkillPath, "utf8");
          expect(stagedContent).toContain(`description: ${newDescription}`);
          expect(stagedContent).toContain("## When to Use");
          return {
            triggeredSkillNames: ["deck-skill"],
            readSkillPaths: [input.targetSkillPath],
            rawOutput: "",
            sessionId: "runtime-session-description",
          };
        },
      });

      expect(result?.passed).toBe(true);
      expect(result?.evidence).toContain("runtime replay session runtime-session-description");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("stages full body content for runtime replay when requested", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Create decks and slide presentations.",
        ["Presentation building requests"],
      );
      const fixture = makeFixture(targetPath);
      const newBody = [
        "Coordinate board-ready presentations and investor updates.",
        "",
        "## Workflow Routing",
        "",
        "| Trigger | Workflow |",
        "| --- | --- |",
        "| board deck, investor update | present |",
      ].join("\n");

      const [result] = await runClaudeRuntimeReplayFixture({
        routing: newBody,
        contentTarget: "body",
        evalSet: [{ query: "create a board deck", should_trigger: true }],
        fixture,
        runtimeInvoker: async (input) => {
          const stagedContent = readFileSync(input.targetSkillPath, "utf8");
          expect(stagedContent).toContain("# deck-skill");
          expect(stagedContent).toContain(newBody);
          return {
            triggeredSkillNames: ["deck-skill"],
            readSkillPaths: [input.targetSkillPath],
            rawOutput: "",
            sessionId: "runtime-session-body",
          };
        },
      });

      expect(result?.passed).toBe(true);
      expect(result?.evidence).toContain("runtime replay session runtime-session-body");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("throws when claude runtime replay fails", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Create decks and slide presentations.",
        ["Presentation building requests"],
      );
      const fixture = makeFixture(targetPath);

      await expect(
        runClaudeRuntimeReplayFixture({
          routing: "| Trigger | Workflow |\n| --- | --- |\n| create deck, board deck | present |",
          evalSet: [{ query: "create a board deck", should_trigger: true }],
          fixture,
          runtimeInvoker: async () => {
            throw new Error("claude not available");
          },
        }),
      ).rejects.toThrow("claude not available");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("throws when runtime replay returns an error state", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Create decks and slide presentations.",
        ["Presentation building requests"],
      );
      const fixture = makeFixture(targetPath);

      await expect(
        runClaudeRuntimeReplayFixture({
          routing: "| Trigger | Workflow |\n| --- | --- |\n| create deck, board deck | present |",
          evalSet: [{ query: "create a board deck", should_trigger: true }],
          fixture,
          runtimeInvoker: async () => ({
            triggeredSkillNames: [],
            readSkillPaths: [],
            rawOutput: "",
            sessionId: "runtime-session-error",
            runtimeError: "tool call timed out",
          }),
        }),
      ).rejects.toThrow(
        "runtime replay session runtime-session-error did not reach a skill decision",
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("throws when asked to run runtime replay for a non-claude fixture", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Create decks and slide presentations.",
        ["Presentation building requests"],
      );
      const fixture: RoutingReplayFixture = {
        ...makeFixture(targetPath),
        platform: "codex",
      };

      await expect(
        runClaudeRuntimeReplayFixture({
          routing: "| Trigger | Workflow |\n| --- | --- |\n| create deck | present |",
          evalSet: [{ query: "create a board deck", should_trigger: true }],
          fixture,
        }),
      ).rejects.toThrow("runtime replay is only supported for claude_code fixtures");
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
      for (const [sessionId, useRelativeReadPath] of [
        ["runtime-session-read-only", false],
        ["runtime-session-read-only-relative", true],
      ] as const) {
        const [result] = await runClaudeRuntimeReplayFixture({
          routing: "| Trigger | Workflow |\n| --- | --- |\n| create deck, board deck | present |",
          evalSet: [{ query: "create a board deck", should_trigger: true }],
          fixture,
          runtimeInvoker: async (input) => ({
            triggeredSkillNames: [],
            readSkillPaths: [
              useRelativeReadPath ? ".claude/skills/deck-skill/SKILL.md" : input.targetSkillPath,
            ],
            rawOutput: "",
            sessionId,
          }),
        });

        expect(result?.triggered).toBe(false);
        expect(result?.passed).toBe(false);
        expect(result?.evidence).toContain("only read the target skill without selecting it");
      }
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
          triggeredSkillNames: [],
          readSkillPaths: [],
          rawOutput: "",
          sessionId: "runtime-session-none",
        }),
      });

      expect(result?.triggered).toBe(false);
      expect(result?.passed).toBe(true);
      expect(result?.evidence).toContain("did not select any local project skill");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("treats reads outside the staged skill set as a failed negative", async () => {
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
        runtimeInvoker: async (input) => ({
          triggeredSkillNames: [],
          readSkillPaths: [join(dirname(input.targetSkillPath), "..", "..", "README.md")],
          rawOutput: "",
          sessionId: "runtime-session-unrelated-read",
        }),
      });

      expect(result?.triggered).toBe(false);
      expect(result?.passed).toBe(false);
      expect(result?.evidence).toContain("read files outside staged skill set");
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
          triggeredSkillNames: ["browser"],
          readSkillPaths: [],
          rawOutput: "",
          sessionId: "runtime-session-unrelated",
        }),
      });

      expect(result?.triggered).toBe(false);
      expect(result?.passed).toBe(false);
      expect(result?.evidence).toContain("selected unrelated skill: browser");
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
          triggeredSkillNames: ["browser"],
          readSkillPaths: [],
          rawOutput: "",
          sessionId: "runtime-session-unrelated-negative",
        }),
      });

      expect(result?.triggered).toBe(false);
      expect(result?.passed).toBe(false);
      expect(result?.evidence).toContain("selected unrelated skill: browser");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("treats multiple selected skills as an ambiguous failure", async () => {
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
          triggeredSkillNames: ["deck-skill", "compare-skill"],
          readSkillPaths: [],
          rawOutput: "",
          sessionId: "runtime-session-ambiguous",
        }),
      });

      expect(result?.triggered).toBe(false);
      expect(result?.passed).toBe(false);
      expect(result?.evidence).toContain("selected multiple skills: deck-skill, compare-skill");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("uses codex runtime replay when a runtime invoker is provided", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Create decks and slide presentations.",
        ["Presentation building requests"],
      );
      const fixture: RoutingReplayFixture = {
        ...makeFixture(targetPath),
        fixture_id: "fixture-routing-codex",
        platform: "codex",
      };

      const [result] = await runHostRuntimeReplayFixture({
        routing: "| Trigger | Workflow |\n| --- | --- |\n| create deck, board deck | present |",
        evalSet: [{ query: "create a board deck", should_trigger: true }],
        fixture,
        runtimeInvoker: async (input) => {
          expect(input.platform).toBe("codex");
          expect(input.skillRegistryDir).toContain(".agents/skills");
          return {
            triggeredSkillNames: ["deck-skill"],
            readSkillPaths: [".agents/skills/deck-skill/SKILL.md"],
            rawOutput: "",
            sessionId: "runtime-session-codex",
          };
        },
      });

      expect(result?.passed).toBe(true);
      expect(result?.evidence).toContain("selected target skill: deck-skill");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("uses opencode runtime replay when a runtime invoker is provided", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-replay-"));
    try {
      const targetPath = writeSkill(
        rootDir,
        "deck-skill",
        "Create decks and slide presentations.",
        ["Presentation building requests"],
      );
      const fixture: RoutingReplayFixture = {
        ...makeFixture(targetPath),
        fixture_id: "fixture-routing-opencode",
        platform: "opencode",
      };

      const [result] = await runHostRuntimeReplayFixture({
        routing: "| Trigger | Workflow |\n| --- | --- |\n| create deck, board deck | present |",
        evalSet: [{ query: "create a board deck", should_trigger: true }],
        fixture,
        runtimeInvoker: async (input) => {
          expect(input.platform).toBe("opencode");
          expect(input.skillRegistryDir).toContain(".opencode/skills");
          return {
            triggeredSkillNames: ["deck-skill"],
            readSkillPaths: [".opencode/skills/deck-skill/SKILL.md"],
            rawOutput: "",
            sessionId: "runtime-session-opencode",
          };
        },
      });

      expect(result?.passed).toBe(true);
      expect(result?.evidence).toContain("selected target skill: deck-skill");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("parses codex runtime JSONL into triggered skills and read paths", () => {
    const observation = parseCodexRuntimeReplayOutput(
      [
        '{"type":"thread.started","thread_id":"th-123"}',
        '{"type":"item.completed","item":{"item_type":"command_execution","command":"cat .agents/skills/deck-skill/SKILL.md","exit_code":0}}',
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"use compare-skill for a pricing tradeoff"}]}}',
      ].join("\n"),
      new Set(["deck-skill", "compare-skill"]),
    );

    expect(observation.sessionId).toBe("th-123");
    expect(observation.triggeredSkillNames).toEqual(["deck-skill", "compare-skill"]);
    expect(observation.readSkillPaths).toEqual([".agents/skills/deck-skill/SKILL.md"]);
  });

  test("parses opencode runtime JSON into triggered skills and read paths", () => {
    const observation = parseOpenCodeRuntimeReplayOutput(
      [
        '{"type":"tool","timestamp":1,"sessionID":"ses-123","tool":"read","state":{"status":"completed","input":{"filePath":".opencode/skills/deck-skill/SKILL.md"},"metadata":{"exit":0}}}',
        '{"type":"reasoning","timestamp":2,"sessionID":"ses-123","text":"use compare-skill for this pricing question"}',
      ].join("\n"),
      new Set(["deck-skill", "compare-skill"]),
    );

    expect(observation.sessionId).toBe("ses-123");
    expect(observation.triggeredSkillNames).toEqual(["deck-skill", "compare-skill"]);
    expect(observation.readSkillPaths).toEqual([".opencode/skills/deck-skill/SKILL.md"]);
  });

  test("parses opencode reasoning path references into triggered skills", () => {
    const observation = parseOpenCodeRuntimeReplayOutput(
      [
        '{"type":"reasoning","timestamp":1,"sessionID":"ses-456","text":"I should inspect .opencode/skills/deck-skill/SKILL.md before answering."}',
      ].join("\n"),
      new Set(["deck-skill", "compare-skill"]),
    );

    expect(observation.sessionId).toBe("ses-456");
    expect(observation.triggeredSkillNames).toEqual(["deck-skill"]);
    expect(observation.readSkillPaths).toEqual([".opencode/skills/deck-skill/SKILL.md"]);
  });
});
