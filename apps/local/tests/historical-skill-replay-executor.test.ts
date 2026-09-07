import { describe, expect, test } from "bun:test";

import { qualifyVerifierInstrument } from "@selftune/skill-intelligence/verifier-instruments";
import { Effect } from "effect";

import {
  assessToIssuesDraftQuality,
  historicalRoutingVerifierQualification,
  historicalTaskQualityVerifierQualification,
  makeHostHistoricalSkillReplayExecutorFactory,
  verifyToIssuesDraftQuality,
} from "../src/historical-skill-replay-executor.js";

const revision = (character: string): string => character.repeat(64);

const benchmarkCase = {
  case_id: "historical-case-1",
  task_payload: "Break this plan into independently grabbable issues.",
  task_fingerprint: `sha256:${"d".repeat(64)}`,
  partition: "selection" as const,
  regression_case: false,
};

describe("historical host replay executor", () => {
  test("qualifies and applies the deterministic to-issues execution contract", () => {
    expect(historicalTaskQualityVerifierQualification().status).toBe("qualified");
    expect(
      verifyToIssuesDraftQuality(
        "Create release issues /to-issues",
        "## 1. Release slice\n\n## Acceptance criteria\n- [ ] Verified\n\n## Blocked by\nNone - can start immediately",
      ),
    ).toBe(true);
    expect(
      verifyToIssuesDraftQuality(
        "Create release issues /to-issues",
        "## 1. Release slice\nAcceptance criteria: verified\nBlocked by: none\nDoes the granularity feel right (too coarse / too fine)?",
      ),
    ).toBe(false);
    expect(assessToIssuesDraftQuality("Create release issues", "1. Release slice")).toEqual({
      passed: false,
      failures: ["missing_acceptance_criteria", "missing_blocked_by_dependencies"],
    });
    expect(
      verifyToIssuesDraftQuality(
        "Create release issues",
        "1. **Release slice**\n- Verify smoke tests.\n- Record evidence.\n- Blocked by: None.",
      ),
    ).toBe(true);
    expect(
      verifyToIssuesDraftQuality(
        "Create release issues",
        "1. **Release slice**\n- Verify smoke tests.\n- Record evidence.\n- Blocked by: None.\nDoes this granularity and dependency order look right?",
      ),
    ).toBe(false);
  });

  test("runs the execution-quality arms with Luna max and records bounded outputs", async () => {
    const calls: Array<{
      body: string;
      includeTargetSkill: boolean;
      model: string;
      reasoningEffort: string;
    }> = [];
    const observations: Array<{ arm: string; passed: boolean; output: string }> = [];
    const factory = makeHostHistoricalSkillReplayExecutorFactory({
      findExecutable: () => "/usr/local/bin/codex",
      runTaskReplay: async (input) => {
        calls.push({
          body: input.body,
          includeTargetSkill: input.includeTargetSkill,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
        });
        const output =
          input.body === "candidate body"
            ? "## 1. Release slice\n\n## Acceptance criteria\n- [ ] Verified\n\n## Blocked by\nNone - can start immediately"
            : "Does the granularity feel right (too coarse / too fine)?";
        return {
          output,
          raw_output: "",
          session_id: "task-replay",
          duration_ms: 25,
          input_tokens: 20,
          output_tokens: 10,
        };
      },
    });
    const qualification = historicalTaskQualityVerifierQualification();
    const executor = await Effect.runPromise(
      factory.create({
        skillName: "to-issues",
        skillPath: "/tmp/skills/to-issues/SKILL.md",
        currentBody: "current body",
        candidateBody: "candidate body",
        currentRevision: revision("a"),
        candidateRevision: revision("b"),
        runtime: {
          harness: "codex",
          model: "gpt-5.6-luna",
          config_digest: `sha256:${"c".repeat(64)}`,
        },
        qualifiedVerifier: qualification,
        recordObservation: (observation) => observations.push(observation),
      }),
    );
    const result = await Effect.runPromise(
      executor.execute({
        case: benchmarkCase,
        arm: "candidate_skill",
        revision: revision("b"),
        repetition: 1,
        attempt: 1,
        runtime: {
          harness: "codex",
          model: "gpt-5.6-luna",
          config_digest: `sha256:${"c".repeat(64)}`,
        },
        verifier_id: qualification.instrument.verifier_id,
        verifier_version: qualification.instrument.version,
      }),
    );

    expect(calls).toEqual([
      {
        body: "candidate body",
        includeTargetSkill: true,
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
      },
    ]);
    expect(result).toMatchObject({
      kind: "scored",
      passed: true,
      executed_revision: revision("b"),
      process: { input_tokens: 20, output_tokens: 10, wall_time_ms: 25 },
    });
    expect(observations).toMatchObject([
      {
        arm: "candidate_skill",
        passed: true,
        output:
          "## 1. Release slice\n\n## Acceptance criteria\n- [ ] Verified\n\n## Blocked by\nNone - can start immediately",
      },
    ]);
  });

  test("stages no, current, and candidate skill arms and retains process evidence", async () => {
    const observed: Array<{
      body: string;
      includeTargetSkill: boolean;
      model?: string;
      reasoningEffort?: string;
    }> = [];
    const factory = makeHostHistoricalSkillReplayExecutorFactory({
      findExecutable: () => "/usr/local/bin/codex",
      runReplay: async (input) => {
        observed.push({
          body: input.routing,
          includeTargetSkill: input.includeTargetSkill ?? true,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
        });
        const passed = input.includeTargetSkill === true && input.routing === "candidate body";
        return [
          {
            query: input.evalSet[0]?.query ?? "",
            should_trigger: true,
            triggered: passed,
            passed,
            runtime_metrics: {
              input_tokens: 12,
              output_tokens: 3,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              total_cost_usd: null,
              duration_ms: 45,
              num_turns: 1,
            },
          },
        ];
      },
    });
    const currentRevision = revision("a");
    const candidateRevision = revision("b");
    const executor = await Effect.runPromise(
      factory.create({
        skillName: "to-issues",
        skillPath: "/tmp/skills/to-issues/SKILL.md",
        currentBody: "current body",
        candidateBody: "candidate body",
        currentRevision,
        candidateRevision,
        runtime: {
          harness: "codex",
          model: "gpt-5.6-luna",
          config_digest: `sha256:${"c".repeat(64)}`,
        },
        qualifiedVerifier: historicalRoutingVerifierQualification(),
      }),
    );

    const execute = (arm: "no_skill" | "current_skill" | "candidate_skill") =>
      Effect.runPromise(
        executor.execute({
          case: benchmarkCase,
          arm,
          revision:
            arm === "no_skill"
              ? null
              : arm === "current_skill"
                ? currentRevision
                : candidateRevision,
          repetition: 1,
          attempt: 1,
          runtime: {
            harness: "codex",
            model: "gpt-5.6-luna",
            config_digest: `sha256:${"c".repeat(64)}`,
          },
          verifier_id: historicalRoutingVerifierQualification().instrument.verifier_id,
          verifier_version: historicalRoutingVerifierQualification().instrument.version,
        }),
      );
    const [withoutSkill, current, candidate] = await Promise.all([
      execute("no_skill"),
      execute("current_skill"),
      execute("candidate_skill"),
    ]);

    expect(observed).toEqual([
      {
        body: "current body",
        includeTargetSkill: false,
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
      },
      {
        body: "current body",
        includeTargetSkill: true,
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
      },
      {
        body: "candidate body",
        includeTargetSkill: true,
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
      },
    ]);
    expect(withoutSkill).toMatchObject({ kind: "scored", passed: false, executed_revision: null });
    expect(current).toMatchObject({
      kind: "scored",
      passed: false,
      executed_revision: currentRevision,
    });
    expect(candidate).toMatchObject({
      kind: "scored",
      passed: true,
      executed_revision: candidateRevision,
      process: { turns: 1, input_tokens: 12, output_tokens: 3, wall_time_ms: 45 },
    });
  });

  test("rejects a verifier whose claim does not match the deterministic routing check", async () => {
    const unrelatedVerifier = qualifyVerifierInstrument({
      instrument: {
        verifier_id: "unrelated-check",
        version: "v1",
        kind: "deterministic",
        success_contract: "An unrelated check passes.",
        check_description: "Checks something else.",
      },
      evidence: (["known_failure", "known_good", "boundary", "adversarial"] as const).map(
        (label) => ({
          evidence_id: `unrelated-${label}`,
          label,
          expected_decision: label === "known_failure" ? ("reject" as const) : ("accept" as const),
          observed_decision: label === "known_failure" ? ("reject" as const) : ("accept" as const),
          partition: "verifier_calibration" as const,
          candidate_strategy_reference: null,
        }),
      ),
    });
    const result = await Effect.runPromiseExit(
      makeHostHistoricalSkillReplayExecutorFactory({
        findExecutable: () => "/usr/local/bin/codex",
      }).create({
        skillName: "to-issues",
        skillPath: "/tmp/skills/to-issues/SKILL.md",
        currentBody: "current body",
        candidateBody: "candidate body",
        currentRevision: revision("a"),
        candidateRevision: revision("b"),
        runtime: {
          harness: "codex",
          model: "configured-default",
          config_digest: `sha256:${"c".repeat(64)}`,
        },
        qualifiedVerifier: unrelatedVerifier,
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain(
        "requires verifier selftune.skill-routing-selection@v1",
      );
    }
  });
});
