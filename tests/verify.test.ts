import { describe, expect, test } from "bun:test";

import type { CreatePackageEvaluationResult } from "../packages/runtime/create/package-evaluator.js";
import { runVerify } from "../packages/runtime/verify.js";
import type { CreateCheckResult } from "../packages/runtime/types.js";

function makeReadiness(
  state: CreateCheckResult["state"],
  overrides: Partial<CreateCheckResult> = {},
): CreateCheckResult {
  return {
    skill: "research-assistant",
    skill_dir: "/tmp/research-assistant",
    skill_path: "/tmp/research-assistant/SKILL.md",
    ok: state === "ready_to_publish",
    state,
    next_command: null,
    spec_validation: {
      ok: true,
      issues: [],
      raw_stdout: "",
      raw_stderr: "",
      exit_code: 0,
      validator: "skills-ref",
      command: "uvx skills-ref validate /tmp/research-assistant",
    },
    readiness: {
      ok: state === "ready_to_publish",
      state,
      summary: state,
      next_command: null,
      checks: {
        skill_md: true,
        frontmatter_present: true,
        skill_name_matches_dir: true,
        description_present: true,
        description_within_budget: true,
        skill_md_within_line_budget: true,
        manifest_present: true,
        workflow_entry: true,
        references_present: true,
        scripts_present: false,
        assets_present: false,
        evals_present: state !== "needs_evals",
        unit_tests_present: !["needs_evals", "needs_unit_tests"].includes(state),
        routing_replay_ready: !["needs_evals", "needs_unit_tests", "needs_routing_replay"].includes(
          state,
        ),
        routing_replay_recorded: state !== "needs_routing_replay",
        package_replay_ready: state !== "needs_routing_replay",
        baseline_present: state !== "needs_baseline",
      },
      skill_name: "research-assistant",
      skill_dir: "/tmp/research-assistant",
      skill_path: "/tmp/research-assistant/SKILL.md",
      entry_workflow: "workflows/default.md",
      manifest_present: true,
      description_quality: {
        composite: 1,
        criteria: {
          length: 1,
          trigger_context: 1,
          vagueness: 1,
          specificity: 1,
          not_just_name: 1,
        },
      },
    },
    ...overrides,
  };
}

function makeReport(): CreatePackageEvaluationResult {
  return {
    summary: {
      skill_name: "research-assistant",
      skill_path: "/tmp/research-assistant/SKILL.md",
      mode: "package",
      evaluation_source: "fresh",
      status: "passed",
      evaluation_passed: true,
      next_command: null,
      replay: {
        mode: "package",
        validation_mode: "host_replay",
        agent: "claude",
        proposal_id: null,
        fixture_id: null,
        total: 1,
        passed: 1,
        failed: 0,
        pass_rate: 1,
      },
      baseline: {
        mode: "package",
        baseline_pass_rate: 0.3,
        with_skill_pass_rate: 0.9,
        lift: 0.6,
        adds_value: true,
        measured_at: "2026-04-15T00:00:00.000Z",
      },
    },
    replay: {
      skill: "research-assistant",
      skill_path: "/tmp/research-assistant/SKILL.md",
      mode: "package",
      agent: "claude",
      proposal_id: null,
      total: 1,
      passed: 1,
      failed: 0,
      pass_rate: 1,
      fixture_id: null,
      results: [],
    },
    baseline: {
      skill_name: "research-assistant",
      mode: "package",
      baseline_pass_rate: 0.3,
      with_skill_pass_rate: 0.9,
      lift: 0.6,
      adds_value: true,
      per_entry: [],
      measured_at: "2026-04-15T00:00:00.000Z",
    },
  };
}

describe("runVerify auto-fix", () => {
  test("uses skill-aware synthetic eval generation for missing evals", async () => {
    const readinessSequence = [makeReadiness("needs_evals"), makeReadiness("ready_to_publish")];
    const commands: string[][] = [];

    const result = await runVerify(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
      },
      {
        computeCreateCheckResult: async () =>
          readinessSequence.shift() ?? makeReadiness("ready_to_publish"),
        runSelftuneSubCommand: (command) => {
          commands.push(command);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        runCreateReport: async () => makeReport(),
      },
    );

    expect(commands).toEqual([
      [
        "eval",
        "generate",
        "--skill",
        "research-assistant",
        "--skill-path",
        "/tmp/research-assistant/SKILL.md",
        "--auto-synthetic",
      ],
    ]);
    expect(result.verified).toBe(true);
    expect(result.report?.summary.next_command).toBe(
      "selftune publish --skill-path /tmp/research-assistant/SKILL.md",
    );
  });

  test("uses generated unit tests with the skill name and eval-set context", async () => {
    const readinessSequence = [
      makeReadiness("needs_unit_tests"),
      makeReadiness("ready_to_publish"),
    ];
    const commands: string[][] = [];

    await runVerify(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
        evalSetPath: "/tmp/research-assistant/evals.json",
      },
      {
        computeCreateCheckResult: async () =>
          readinessSequence.shift() ?? makeReadiness("ready_to_publish"),
        runSelftuneSubCommand: (command) => {
          commands.push(command);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        runCreateReport: async () => makeReport(),
      },
    );

    expect(commands).toEqual([
      [
        "eval",
        "unit-test",
        "--skill",
        "research-assistant",
        "--generate",
        "--eval-set",
        "/tmp/research-assistant/evals.json",
        "--skill-path",
        "/tmp/research-assistant/SKILL.md",
      ],
    ]);
  });
});
