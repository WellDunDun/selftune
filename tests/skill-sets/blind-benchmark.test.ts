import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";

import {
  BlindBenchmarkExecutionFailure,
  runBlindBenchmark,
  type BlindBenchmarkProtocol,
  type BlindBenchmarkExecutor,
} from "@selftune/skill-intelligence/blind-benchmark";
import { qualifyVerifierInstrument } from "@selftune/skill-intelligence/verifier-instruments";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const revision = (value: string) => value.repeat(64);
const task = (
  case_id: string,
  partition: "calibration" | "selection" | "audit_holdout",
  regression_case = false,
) => ({
  case_id,
  task_payload: `Task ${case_id}`,
  task_fingerprint: `sha256:${sha(`Task ${case_id}`)}`,
  partition,
  regression_case,
});

const verifier = qualifyVerifierInstrument({
  instrument: {
    verifier_id: "v",
    version: "v1",
    kind: "deterministic",
    success_contract: "success",
    check_description: "check",
  },
  evidence: [
    {
      evidence_id: "f",
      label: "known_failure",
      expected_decision: "reject",
      observed_decision: "reject",
      partition: "verifier_calibration",
      candidate_strategy_reference: null,
    },
    {
      evidence_id: "g",
      label: "known_good",
      expected_decision: "accept",
      observed_decision: "accept",
      partition: "verifier_calibration",
      candidate_strategy_reference: null,
    },
    {
      evidence_id: "b",
      label: "boundary",
      expected_decision: "reject",
      observed_decision: "reject",
      partition: "verifier_calibration",
      candidate_strategy_reference: null,
    },
    {
      evidence_id: "a",
      label: "adversarial",
      expected_decision: "reject",
      observed_decision: "reject",
      partition: "verifier_calibration",
      candidate_strategy_reference: null,
    },
  ],
});

const protocol: BlindBenchmarkProtocol = {
  cases: [
    task("cal", "calibration"),
    task("select", "selection"),
    task("audit", "audit_holdout"),
    task("regression", "calibration", true),
  ],
  candidate_generation_case_ids: ["cal", "regression"],
  qualified_verifier: verifier,
  current_revision: revision("a"),
  installed_current_revision: revision("a"),
  candidate_revision: revision("b"),
  runtime: { harness: "codex", model: "gpt", config_digest: `sha256:${sha("config")}` },
  required_scored_repetitions: 3,
  max_attempts_per_arm: 3,
};

const executor: BlindBenchmarkExecutor = {
  execute(input) {
    const passed =
      input.arm === "candidate_skill" ||
      (input.arm === "current_skill" && input.case.partition === "calibration");
    return Effect.succeed({
      kind: "scored",
      passed,
      executed_revision: input.revision,
    });
  },
};

describe("immutable blind benchmark", () => {
  test("selects only after candidate beats both selection baselines, preserves regressions, and opens audit last", async () => {
    const result = await Effect.runPromise(runBlindBenchmark(protocol, executor));
    expect(result).toMatchObject({
      status: "selected",
      reason: "selected",
      audit_opened: true,
      applies_change: false,
    });
    expect(result.selection_scores).toEqual({ no_skill: 0, current_skill: 0, candidate_skill: 1 });
    expect(result.trials.filter((trial) => trial.partition === "audit_holdout")).toHaveLength(3);
  });

  test("rejects selection or audit case leakage into candidate generation before execution", async () => {
    const leaked = await Effect.runPromise(
      runBlindBenchmark({ ...protocol, candidate_generation_case_ids: ["select"] }, executor),
    );
    expect(leaked).toMatchObject({
      status: "invalid",
      reason: "candidate_generation_leakage",
      audit_opened: false,
    });
  });

  test("does not open audit when the current skill is already saturated", async () => {
    const saturated: BlindBenchmarkExecutor = {
      execute(input) {
        return Effect.succeed({
          kind: "scored",
          passed: true,
          executed_revision: input.revision,
        });
      },
    };
    const result = await Effect.runPromise(runBlindBenchmark(protocol, saturated));
    expect(result).toMatchObject({
      status: "inconclusive",
      reason: "no_measurable_headroom",
      audit_opened: false,
    });
  });

  test("rejects stale, duplicate, fingerprint, and noncanonical verifier protocols before execution", async () => {
    const stale = await Effect.runPromise(
      runBlindBenchmark({ ...protocol, installed_current_revision: revision("c") }, executor),
    );
    const duplicateCases = await Effect.runPromise(
      runBlindBenchmark({ ...protocol, cases: [...protocol.cases, protocol.cases[0]!] }, executor),
    );
    const duplicateGeneration = await Effect.runPromise(
      runBlindBenchmark({ ...protocol, candidate_generation_case_ids: ["cal", "cal"] }, executor),
    );
    const badFingerprint = await Effect.runPromise(
      runBlindBenchmark(
        {
          ...protocol,
          cases: [
            { ...protocol.cases[0]!, task_fingerprint: `sha256:${revision("d")}` },
            ...protocol.cases.slice(1),
          ],
        },
        executor,
      ),
    );
    const unqualified = await Effect.runPromise(
      runBlindBenchmark(
        { ...protocol, qualified_verifier: { ...verifier, reasons: [] } },
        executor,
      ),
    );
    expect(stale.reason).toBe("invalid_protocol");
    expect(duplicateCases.reason).toBe("invalid_protocol");
    expect(duplicateGeneration.reason).toBe("invalid_protocol");
    expect(badFingerprint.reason).toBe("task_fingerprint_mismatch");
    expect(unqualified.reason).toBe("unqualified_verifier");
  });

  test("rejects an aggregate selection win that hides a per-case regression", async () => {
    const cases = [
      task("cal", "calibration"),
      task("s1", "selection"),
      task("s2", "selection"),
      task("audit", "audit_holdout"),
    ];
    const result = await Effect.runPromise(
      runBlindBenchmark(
        { ...protocol, cases, candidate_generation_case_ids: ["cal"] },
        {
          execute(input) {
            const passed =
              input.arm === "candidate_skill"
                ? input.case.case_id !== "s2" || input.repetition < 3
                : input.arm === "current_skill"
                  ? input.case.case_id === "s2"
                  : false;
            return Effect.succeed({ kind: "scored", passed, executed_revision: input.revision });
          },
        },
      ),
    );
    expect(result).toMatchObject({
      status: "inconclusive",
      reason: "candidate_did_not_beat_baselines",
      audit_opened: false,
    });
  });

  test("gates regression failures and audit ties after selection", async () => {
    const regression = await Effect.runPromise(
      runBlindBenchmark(
        { ...protocol },
        {
          execute(input) {
            const passed =
              input.arm === "candidate_skill"
                ? input.case.case_id !== "regression"
                : input.arm === "current_skill" && input.case.partition === "calibration";
            return Effect.succeed({ kind: "scored", passed, executed_revision: input.revision });
          },
        },
      ),
    );
    const auditTie = await Effect.runPromise(
      runBlindBenchmark(protocol, {
        execute(input) {
          const passed =
            input.case.partition === "audit_holdout"
              ? input.arm !== "no_skill"
              : input.arm === "candidate_skill" ||
                (input.arm === "current_skill" && input.case.partition === "calibration");
          return Effect.succeed({ kind: "scored", passed, executed_revision: input.revision });
        },
      }),
    );
    expect(regression.reason).toBe("regression_case_failed");
    expect(auditTie).toMatchObject({ reason: "audit_holdout_failed", audit_opened: true });
  });

  test("censors retryable infrastructure and reports cancellation, budget, and revision mismatch without scored invalid arms", async () => {
    const retried = await Effect.runPromise(
      runBlindBenchmark(protocol, {
        execute(input) {
          if (input.case.case_id === "cal" && input.arm === "no_skill" && input.attempt === 1)
            return Effect.succeed({ kind: "infrastructure", retryable: true });
          return executor.execute(input);
        },
      }),
    );
    const cancelled = await Effect.runPromise(
      runBlindBenchmark(protocol, {
        execute() {
          return Effect.fail(
            new BlindBenchmarkExecutionFailure({ kind: "cancelled", retryable: false }),
          );
        },
      }),
    );
    const budget = await Effect.runPromise(
      runBlindBenchmark(protocol, {
        execute() {
          return Effect.fail(
            new BlindBenchmarkExecutionFailure({ kind: "budget_exhausted", retryable: false }),
          );
        },
      }),
    );
    const noSkillMismatch = await Effect.runPromise(
      runBlindBenchmark(protocol, {
        execute(input) {
          return Effect.succeed({
            kind: "scored",
            passed: false,
            executed_revision: input.arm === "no_skill" ? revision("e") : input.revision,
          });
        },
      }),
    );
    expect(retried.status).toBe("selected");
    expect(retried.trials[0]!.censored_attempts).toBe(3);
    expect(cancelled).toMatchObject({ reason: "cancelled", trials: [] });
    expect(budget).toMatchObject({ reason: "budget_exhausted", trials: [] });
    expect(noSkillMismatch).toMatchObject({
      status: "invalid",
      reason: "executor_revision_mismatch",
      trials: [],
    });
  });
});
