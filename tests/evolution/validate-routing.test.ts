import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  BodyEvolutionProposal,
  EvalEntry,
  RoutingReplayFixture,
  RoutingReplayEntryResult,
} from "../../cli/selftune/types.js";
import { stripMarkdownFences } from "../../cli/selftune/utils/llm-call.js";

// ---------------------------------------------------------------------------
// Mock callLlm before importing the module under test
// ---------------------------------------------------------------------------

const mockCallLlm = mock(async (_sys: string, _user: string, _agent: string) => {
  return "NO";
});

mock.module("../../cli/selftune/utils/llm-call.js", () => ({
  callLlm: mockCallLlm,
  stripMarkdownFences,
}));

// Import after mocking
const { validateRoutingStructure, validateRoutingTriggerAccuracy, validateRoutingProposal } =
  await import("../../cli/selftune/evolution/validate-routing.js");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeEval(query: string, shouldTrigger: boolean): EvalEntry {
  return { query, should_trigger: shouldTrigger };
}

function makeRoutingProposal(
  overrides: Partial<BodyEvolutionProposal> = {},
): BodyEvolutionProposal {
  return {
    proposal_id: "evo-routing-test-001",
    skill_name: "test-skill",
    skill_path: "/skills/test-skill",
    original_body: "| Trigger | Workflow |\n| --- | --- |\n| make slides | presentation |",
    proposed_body:
      "| Trigger | Workflow |\n| --- | --- |\n| make slides | presentation |\n| create deck | presentation |",
    rationale: "Added deck trigger",
    target: "routing",
    failure_patterns: ["fp-test-0"],
    confidence: 0.8,
    created_at: new Date().toISOString(),
    status: "pending",
    ...overrides,
  };
}

function writeReplaySkill(
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

// ---------------------------------------------------------------------------
// validateRoutingStructure
// ---------------------------------------------------------------------------

describe("validateRoutingStructure", () => {
  test("valid table passes", () => {
    const table = "| Trigger | Workflow |\n| --- | --- |\n| make slides | presentation |";
    const result = validateRoutingStructure(table);
    expect(result.valid).toBe(true);
  });

  test("empty string fails", () => {
    const result = validateRoutingStructure("");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("at least a header");
  });

  test("missing Trigger column fails", () => {
    const table = "| Action | Workflow |\n| --- | --- |\n| make slides | presentation |";
    const result = validateRoutingStructure(table);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Trigger");
  });

  test("missing Workflow column fails", () => {
    const table = "| Trigger | Result |\n| --- | --- |\n| make slides | presentation |";
    const result = validateRoutingStructure(table);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Workflow");
  });

  test("missing separator row fails", () => {
    const table = "| Trigger | Workflow |\n| make slides | presentation |";
    const result = validateRoutingStructure(table);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("separator");
  });

  test("header only (no data rows) fails", () => {
    const table = "| Trigger | Workflow |\n| --- | --- |";
    const result = validateRoutingStructure(table);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("data row");
  });

  test("data row without pipes fails", () => {
    const table = "| Trigger | Workflow |\n| --- | --- |\nmake slides presentation";
    const result = validateRoutingStructure(table);
    expect(result.valid).toBe(false);
  });

  test("multiple data rows pass", () => {
    const table =
      "| Trigger | Workflow |\n| --- | --- |\n| make slides | presentation |\n| create deck | presentation |";
    const result = validateRoutingStructure(table);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateRoutingTriggerAccuracy
// ---------------------------------------------------------------------------

describe("validateRoutingTriggerAccuracy", () => {
  test("empty eval set returns zeros", async () => {
    const result = await validateRoutingTriggerAccuracy("original", "proposed", [], "claude");
    expect(result.before_pass_rate).toBe(0);
    expect(result.after_pass_rate).toBe(0);
    expect(result.improved).toBe(false);
  });

  test("when LLM always says NO, negative evals pass and positive fail", async () => {
    mockCallLlm.mockImplementation(async () => "NO");

    const evalSet = [makeEval("trigger query", true), makeEval("negative query", false)];
    const result = await validateRoutingTriggerAccuracy("original", "proposed", evalSet, "claude");

    expect(result.before_pass_rate).toBeCloseTo(0.5, 5);
    expect(result.after_pass_rate).toBeCloseTo(0.5, 5);
    expect(result.improved).toBe(false);
  });

  test("detects improvement when proposed gets better results", async () => {
    mockCallLlm.mockImplementation(async (_sys: string, user: string) => {
      if (user.includes("create deck")) return "YES";
      return "NO";
    });

    const evalSet = [makeEval("negative query", false)];
    const result = await validateRoutingTriggerAccuracy("original", "proposed", evalSet, "claude");
    expect(typeof result.before_pass_rate).toBe("number");
    expect(typeof result.after_pass_rate).toBe("number");
  });

  test("prefers replay validation when a fixture is available", async () => {
    mockCallLlm.mockClear();
    const replayFixture: RoutingReplayFixture = {
      fixture_id: "fixture-claude-routing-1",
      platform: "claude_code",
      target_skill_name: "test-skill",
      target_skill_path: "/skills/test-skill/SKILL.md",
      competing_skill_paths: ["/skills/other-skill/SKILL.md"],
    };
    const replayRunner = mock(
      async ({ routing, evalSet }: { routing: string; evalSet: EvalEntry[] }) =>
        evalSet.map<RoutingReplayEntryResult>((entry) => {
          const triggered = routing.includes("create deck") ? entry.should_trigger : false;
          return {
            query: entry.query,
            should_trigger: entry.should_trigger,
            triggered,
            passed: triggered === entry.should_trigger,
            evidence: triggered ? "skill invoked in replay" : "skill not invoked in replay",
          };
        }),
    );

    const evalSet = [makeEval("create deck for board meeting", true)];
    const result = await validateRoutingTriggerAccuracy(
      "original",
      "create deck",
      evalSet,
      "claude",
      undefined,
      {
        replayFixture,
        replayRunner,
      },
    );

    expect(result.validation_mode).toBe("host_replay");
    expect(result.validation_fixture_id).toBe("fixture-claude-routing-1");
    expect(result.before_pass_rate).toBe(0);
    expect(result.after_pass_rate).toBe(1);
    expect(result.per_entry_results?.[0]?.evidence).toContain("replay");
    expect(replayRunner).toHaveBeenCalledTimes(2);
    expect(mockCallLlm).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// validateRoutingProposal
// ---------------------------------------------------------------------------

describe("validateRoutingProposal", () => {
  test("structurally invalid proposal fails gate 1", async () => {
    const proposal = makeRoutingProposal({ proposed_body: "not a table" });
    const evalSet = [makeEval("test", true)];

    const result = await validateRoutingProposal(proposal, evalSet, "claude");

    expect(result.gates_passed).toBe(0);
    expect(result.gates_total).toBe(2);
    expect(result.improved).toBe(false);
    expect(result.gate_results[0].gate).toBe("structural");
    expect(result.gate_results[0].passed).toBe(false);
  });

  test("valid structure passes gate 1, trigger accuracy determines gate 2", async () => {
    mockCallLlm.mockImplementation(async () => "NO");

    const proposal = makeRoutingProposal();
    const evalSet = [makeEval("test", true)];

    const result = await validateRoutingProposal(proposal, evalSet, "claude");

    expect(result.gate_results[0].gate).toBe("structural");
    expect(result.gate_results[0].passed).toBe(true);
    expect(result.gate_results.length).toBe(2);
    expect(result.gates_total).toBe(2);
  });

  test("returns correct proposal_id", async () => {
    mockCallLlm.mockImplementation(async () => "NO");

    const proposal = makeRoutingProposal({ proposal_id: "custom-id" });
    const result = await validateRoutingProposal(proposal, [], "claude");

    expect(result.proposal_id).toBe("custom-id");
  });

  test("records replay provenance when replay validation is used", async () => {
    mockCallLlm.mockClear();
    const replayFixture: RoutingReplayFixture = {
      fixture_id: "fixture-claude-routing-2",
      platform: "claude_code",
      target_skill_name: "test-skill",
      target_skill_path: "/skills/test-skill/SKILL.md",
      competing_skill_paths: [],
    };
    const replayRunner = mock(
      async ({ routing, evalSet }: { routing: string; evalSet: EvalEntry[] }) =>
        evalSet.map<RoutingReplayEntryResult>((entry) => {
          const triggered = routing.includes("create deck");
          return {
            query: entry.query,
            should_trigger: entry.should_trigger,
            triggered,
            passed: triggered === entry.should_trigger,
          };
        }),
    );

    const proposal = makeRoutingProposal();
    const result = await validateRoutingProposal(
      proposal,
      [makeEval("create deck", true)],
      "claude",
      undefined,
      {
        replayFixture,
        replayRunner,
      },
    );

    expect(result.validation_mode).toBe("host_replay");
    expect(result.validation_fixture_id).toBe("fixture-claude-routing-2");
    expect(result.before_pass_rate).toBe(0);
    expect(result.after_pass_rate).toBe(1);
    expect(result.gate_results[1]?.reason).toContain("host_replay");
  });

  test("uses the default fixture-backed replay runner when no custom runner is passed", async () => {
    mockCallLlm.mockClear();
    const rootDir = mkdtempSync(join(tmpdir(), "selftune-routing-"));
    try {
      const targetPath = writeReplaySkill(
        rootDir,
        "test-skill",
        "Create decks and presentation artifacts.",
        ["Presentation, slide, or deck creation requests"],
      );
      const proposal = makeRoutingProposal({
        original_body: "| Trigger | Workflow |\n| --- | --- |\n| make slides | presentation |",
        proposed_body:
          "| Trigger | Workflow |\n| --- | --- |\n| make slides, create deck | presentation |",
      });

      const result = await validateRoutingProposal(
        proposal,
        [makeEval("create deck for the board", true)],
        "claude",
        undefined,
        {
          replayFixture: {
            fixture_id: "fixture-default-runner",
            platform: "claude_code",
            target_skill_name: "test-skill",
            target_skill_path: targetPath,
            competing_skill_paths: [],
          },
        },
      );

      expect(result.validation_mode).toBe("host_replay");
      expect(result.validation_fixture_id).toBe("fixture-default-runner");
      expect(result.before_pass_rate).toBe(0);
      expect(result.after_pass_rate).toBe(1);
      expect(mockCallLlm).not.toHaveBeenCalled();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
