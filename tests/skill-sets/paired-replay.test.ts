import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import {
  PairedReplayExecutionFailure,
  runManagedPairedReplay,
  type ManagedPairedReplayProtocol,
  type PairedReplayArmExecutor,
} from "@selftune/skill-intelligence/paired-replay";
import {
  qualifyVerifierInstrument,
  type VerifierQualificationInput,
} from "@selftune/skill-intelligence/verifier-instruments";

const sha = (character: string) => character.repeat(64);
const fingerprint = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const taskPayload = "Confirm whether the image is uploaded in the portal.";

const verifierQualificationInput: VerifierQualificationInput = {
  instrument: {
    verifier_id: "portal-status",
    version: "v1",
    kind: "deterministic",
    success_contract: "Portal upload status must be confirmed.",
    check_description: "Read the portal status field.",
  },
  evidence: [
    {
      evidence_id: "failure",
      label: "known_failure",
      expected_decision: "reject",
      observed_decision: "reject",
      partition: "verifier_calibration",
      candidate_strategy_reference: null,
    },
    {
      evidence_id: "good",
      label: "known_good",
      expected_decision: "accept",
      observed_decision: "accept",
      partition: "verifier_calibration",
      candidate_strategy_reference: null,
    },
    {
      evidence_id: "boundary",
      label: "boundary",
      expected_decision: "reject",
      observed_decision: "reject",
      partition: "verifier_calibration",
      candidate_strategy_reference: null,
    },
    {
      evidence_id: "adversarial",
      label: "adversarial",
      expected_decision: "reject",
      observed_decision: "reject",
      partition: "verifier_calibration",
      candidate_strategy_reference: null,
    },
  ],
};

const qualifiedVerifier = qualifyVerifierInstrument(verifierQualificationInput);

const protocol: ManagedPairedReplayProtocol = {
  task_case: {
    case_id: "portal-upload",
    task_payload: taskPayload,
    task_fingerprint: fingerprint(taskPayload),
  },
  qualified_verifier: qualifiedVerifier,
  pre_edit_revision: sha("a"),
  post_edit_revision: sha("b"),
  current_revision: sha("b"),
  runtime: { harness: "codex", model: "gpt-5", config_digest: `sha256:${sha("d")}` },
  required_scored_repetitions: 3,
  max_attempts_per_arm: 4,
};

function executorFor(input: {
  pre?: "pass" | "fail";
  post?: "pass" | "fail";
  firstPreInfrastructure?: boolean;
  terminal?: "cancelled" | "budget_exhausted";
  wrongRevision?: boolean;
}): PairedReplayArmExecutor {
  return {
    execute(request) {
      if (input.terminal) {
        return Effect.fail(
          new PairedReplayExecutionFailure({
            kind: input.terminal,
            message: input.terminal,
            retryable: false,
            category: null,
          }),
        );
      }
      if (
        input.firstPreInfrastructure &&
        request.arm === "pre_edit" &&
        request.repetition === 1 &&
        request.attempt === 1
      ) {
        return Effect.succeed({ kind: "infrastructure", category: "network", retryable: true });
      }
      return Effect.succeed({
        kind: "scored",
        passed:
          request.arm === "pre_edit"
            ? (input.pre ?? "fail") === "pass"
            : (input.post ?? "pass") === "pass",
        executed_revision: input.wrongRevision ? sha("f") : request.revision,
      });
    },
  };
}

describe("managed paired replay", () => {
  test("promotes three frozen same-case old-fail/new-pass pairs without applying a skill", async () => {
    const result = await Effect.runPromise(runManagedPairedReplay(protocol, executorFor({})));

    expect(result).toMatchObject({
      status: "promoted",
      reason: "promoted",
      scored_pairs: 3,
      applies_change: false,
    });
    expect(result.trials.map((trial) => [trial.pre_edit, trial.post_edit])).toEqual([
      ["fail", "pass"],
      ["fail", "pass"],
      ["fail", "pass"],
    ]);
  });

  test("retries and censors explicit infrastructure without treating it as a quality loss", async () => {
    const result = await Effect.runPromise(
      runManagedPairedReplay(protocol, executorFor({ firstPreInfrastructure: true })),
    );

    expect(result).toMatchObject({ status: "promoted", censored_attempts: 1, scored_pairs: 3 });
    expect(result.trials[0]).toMatchObject({ pre_edit_attempts: 2, pre_edit: "fail" });
  });

  test("invalidates unqualified or stale protocols before execution", async () => {
    const unqualified = await Effect.runPromise(
      runManagedPairedReplay(
        { ...protocol, qualified_verifier: { ...qualifiedVerifier, status: "rejected" } },
        executorFor({}),
      ),
    );
    const stale = await Effect.runPromise(
      runManagedPairedReplay({ ...protocol, current_revision: sha("e") }, executorFor({})),
    );

    expect(unqualified).toMatchObject({ status: "invalid", reason: "unqualified_verifier" });
    expect(stale).toMatchObject({ status: "invalid", reason: "stale_current_revision" });
  });

  test("reports execution revision mismatch and cancellation/budget exhaustion honestly", async () => {
    const mismatch = await Effect.runPromise(
      runManagedPairedReplay(protocol, executorFor({ wrongRevision: true })),
    );
    const cancelled = await Effect.runPromise(
      runManagedPairedReplay(protocol, executorFor({ terminal: "cancelled" })),
    );
    const budget = await Effect.runPromise(
      runManagedPairedReplay(protocol, executorFor({ terminal: "budget_exhausted" })),
    );

    expect(mismatch).toMatchObject({ status: "invalid", reason: "executor_revision_mismatch" });
    expect(cancelled).toMatchObject({ status: "inconclusive", reason: "cancelled" });
    expect(budget).toMatchObject({ status: "inconclusive", reason: "budget_exhausted" });
    expect(cancelled.trials[0]).toMatchObject({
      pre_edit: "infrastructure_error",
      post_edit: "skipped",
      post_edit_attempts: 0,
      censored_attempts: 0,
    });
    expect(cancelled.scored_pairs).toBe(0);
    expect(budget.scored_pairs).toBe(0);
  });

  test("does not double-count a censored pre arm or fabricate a post arm when the pair cannot continue", async () => {
    const result = await Effect.runPromise(
      runManagedPairedReplay(protocol, {
        execute(request) {
          if (request.arm === "pre_edit") {
            return Effect.succeed({
              kind: "infrastructure",
              category: "network",
              retryable: false,
            });
          }
          throw new Error("The post arm must not execute after a terminal pre arm.");
        },
      }),
    );

    expect(result).toMatchObject({
      status: "inconclusive",
      reason: "insufficient_scored_repetitions",
      censored_attempts: 1,
      scored_pairs: 0,
    });
    expect(result.trials[0]).toMatchObject({
      pre_edit: "infrastructure_error",
      post_edit: "skipped",
      pre_edit_attempts: 1,
      post_edit_attempts: 0,
      censored_attempts: 1,
    });
  });

  test("invalidates a mismatched task fingerprint, noncanonical qualified result, and out-of-bounds protocol budget", async () => {
    const badFingerprint = await Effect.runPromise(
      runManagedPairedReplay(
        {
          ...protocol,
          task_case: { ...protocol.task_case, task_fingerprint: `sha256:${sha("c")}` },
        },
        executorFor({}),
      ),
    );
    const noncanonicalQualification = await Effect.runPromise(
      runManagedPairedReplay(
        { ...protocol, qualified_verifier: { ...qualifiedVerifier, reasons: [] } },
        executorFor({}),
      ),
    );
    const oversizedBudget = await Effect.runPromise(
      runManagedPairedReplay({ ...protocol, required_scored_repetitions: 33 }, executorFor({})),
    );

    expect(badFingerprint).toMatchObject({
      status: "invalid",
      reason: "task_fingerprint_mismatch",
    });
    expect(noncanonicalQualification).toMatchObject({
      status: "invalid",
      reason: "unqualified_verifier",
    });
    expect(oversizedBudget).toMatchObject({ status: "invalid", reason: "invalid_protocol_budget" });
  });

  test("binds the complete qualification result into the frozen manifest", async () => {
    const first = await Effect.runPromise(runManagedPairedReplay(protocol, executorFor({})));
    const changedInstrument = await Effect.runPromise(
      runManagedPairedReplay(
        {
          ...protocol,
          qualified_verifier: {
            ...qualifiedVerifier,
            instrument: { ...qualifiedVerifier.instrument, version: "v2" },
          },
        },
        executorFor({}),
      ),
    );

    expect(changedInstrument.manifest_id).not.toBe(first.manifest_id);
  });

  test("keeps old unexpectedly passing and corrected mixed/failing evidence inconclusive", async () => {
    const oldPasses = await Effect.runPromise(
      runManagedPairedReplay(protocol, executorFor({ pre: "pass" })),
    );
    const correctedFails = await Effect.runPromise(
      runManagedPairedReplay(protocol, executorFor({ post: "fail" })),
    );
    const mixed = await Effect.runPromise(
      runManagedPairedReplay(protocol, {
        execute(request) {
          return Effect.succeed({
            kind: "scored",
            passed: request.arm === "post_edit" ? request.repetition < 3 : false,
            executed_revision: request.revision,
          });
        },
      }),
    );

    expect(oldPasses).toMatchObject({ status: "inconclusive", reason: "old_unexpectedly_passing" });
    expect(correctedFails).toMatchObject({ status: "inconclusive", reason: "corrected_failing" });
    expect(mixed).toMatchObject({ status: "inconclusive", reason: "mixed_replay_results" });
  });
});
