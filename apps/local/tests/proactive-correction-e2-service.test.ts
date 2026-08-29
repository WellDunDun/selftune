import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { listLatestCorrectionCandidateEvaluations, openDb } from "@selftune/local-store";
import * as Effect from "effect/Effect";

import {
  type ProactiveCandidateEvaluationPersistence,
  type ProactiveCandidateEvaluationRecord,
  ProactiveCandidateEvaluationPersistenceFailure,
  makeLocalStoreProactiveCandidateEvaluationPersistence,
  runProactiveCorrectionE2,
} from "../src/proactive-correction-e2-service.js";
import { qualifyVerifierInstrument } from "@selftune/skill-intelligence/verifier-instruments";

const revision = (character: string) => character.repeat(64);
const fingerprint = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function qualifiedVerifier() {
  return qualifyVerifierInstrument({
    instrument: {
      verifier_id: "portal-check",
      version: "v1",
      kind: "deterministic",
      success_contract: "Portal state must match the claim.",
      check_description: "Checks the portal state.",
    },
    evidence: ["known_failure", "known_good", "boundary", "adversarial"].map((label) => ({
      evidence_id: `control-${label}`,
      label,
      expected_decision: label === "known_failure" ? "reject" : "accept",
      observed_decision: label === "known_failure" ? "reject" : "accept",
      partition: "verifier_calibration",
      candidate_strategy_reference: null,
    })),
  });
}

function input() {
  const calibration = "calibration task";
  const selection = "regression task";
  const audit = "audit task";
  return {
    candidate: {
      candidate_id: "candidate-1",
      skill_id: "release-checklist",
      skill_name: "release-checklist",
      candidate_kind: "existing_skill_body_mutation",
      installed_body: "Require evidence before claiming success.",
      proposed_body: "Require portal evidence before claiming upload success.",
      installed_revision: revision("a"),
      candidate_revision: revision("b"),
      changed_lines: 1,
      cross_file_edits: false,
      protected_metadata_changed: false,
    },
    observed_installed_revision: revision("a"),
    protocol: {
      cases: [
        {
          case_id: "calibration-1",
          task_payload: calibration,
          task_fingerprint: fingerprint(calibration),
          partition: "calibration",
          regression_case: false,
        },
        {
          case_id: "regression-1",
          task_payload: selection,
          task_fingerprint: fingerprint(selection),
          partition: "selection",
          regression_case: true,
        },
        {
          case_id: "audit-1",
          task_payload: audit,
          task_fingerprint: fingerprint(audit),
          partition: "audit_holdout",
          regression_case: false,
        },
      ],
      candidate_generation_case_ids: ["calibration-1"],
      qualified_verifier: qualifiedVerifier(),
      current_revision: revision("a"),
      installed_current_revision: revision("a"),
      candidate_revision: revision("b"),
      runtime: { harness: "codex", model: "gpt-5", config_digest: `sha256:${revision("c")}` },
      required_scored_repetitions: 3,
      max_attempts_per_arm: 3,
    },
    active_regression_cases: [
      {
        case_id: "regression-1",
        skill_id: "release-checklist",
        status: "active",
        task_fingerprint: fingerprint(selection),
      },
    ],
    controls: {
      entitlement_proactive_managed: true,
      proactive_generation_enabled: true,
      managed_execution_enabled: true,
      kill_switch_enabled: false,
      active_runs: 0,
      max_concurrency: 1,
      budget_remaining_usd: 3,
      estimated_cost_usd: 1,
    },
    recorded_at: "2026-07-29T12:00:00.000Z",
  };
}

function executor(kind: "selected" | "tie" | "regression_fail" | "infra" | "cancelled") {
  return {
    execute: (request: {
      readonly arm: "no_skill" | "current_skill" | "candidate_skill";
      readonly case: { readonly case_id: string };
      readonly revision: string | null;
    }) => {
      if (kind === "infra")
        return Effect.succeed({ kind: "infrastructure" as const, retryable: false });
      if (kind === "cancelled") return Effect.succeed({ kind: "cancelled" as const });
      const candidate = request.arm === "candidate_skill";
      const passed =
        kind === "selected"
          ? candidate
          : kind === "tie"
            ? request.arm !== "no_skill"
            : request.case.case_id !== "regression-1" || !candidate;
      return Effect.succeed({
        kind: "scored" as const,
        passed,
        executed_revision: request.revision,
      });
    },
  };
}

function persistence(
  records: ProactiveCandidateEvaluationRecord[] = [],
): ProactiveCandidateEvaluationPersistence {
  return {
    persist: (entry) => {
      records.push(entry);
      return Effect.succeed(entry);
    },
  };
}

describe("proactive missed-correction E2 coordinator", () => {
  test("selects E2 only as review-ready and never applies", async () => {
    const records: ProactiveCandidateEvaluationRecord[] = [];
    const result = await Effect.runPromise(
      runProactiveCorrectionE2(input(), executor("selected"), persistence(records)),
    );
    expect(result).toMatchObject({
      status: "review_ready",
      evidence_level: "E2",
      reason: "selected",
      applies_change: false,
    });
    expect(records[0]?.immutable_manifest_json).toContain(
      '"candidate_kind":"existing_skill_body_mutation"',
    );
  });

  test("keeps ties, regression failures, infrastructure, and cancellation honest", async () => {
    const results = await Promise.all(
      (["tie", "regression_fail", "infra", "cancelled"] as const).map((kind) =>
        Effect.runPromise(runProactiveCorrectionE2(input(), executor(kind), persistence())),
      ),
    );
    for (const result of results) {
      expect(result.status).toBe("not_ready");
      expect(result.evidence_level).toBe("E0.5");
      expect(result.applies_change).toBe(false);
    }
  });

  test("blocks missing regressions, stale pins, and policy or cost controls before execution", async () => {
    const cases = [
      {
        ...input(),
        active_regression_cases: [
          {
            case_id: "regression-missing",
            skill_id: "release-checklist",
            status: "active",
            task_fingerprint: fingerprint("missing task"),
          },
        ],
      },
      { ...input(), observed_installed_revision: revision("d") },
      {
        ...input(),
        active_regression_cases: [
          {
            ...input().active_regression_cases[0],
            task_fingerprint: fingerprint("spoofed regression"),
          },
        ],
      },
      { ...input(), controls: { ...input().controls, entitlement_proactive_managed: false } },
      { ...input(), controls: { ...input().controls, proactive_generation_enabled: false } },
      { ...input(), controls: { ...input().controls, managed_execution_enabled: false } },
      { ...input(), controls: { ...input().controls, kill_switch_enabled: true } },
      { ...input(), controls: { ...input().controls, active_runs: 1 } },
      { ...input(), controls: { ...input().controls, budget_remaining_usd: 0 } },
    ];
    const results = await Promise.all(
      cases.map((candidate) =>
        Effect.runPromise(runProactiveCorrectionE2(candidate, executor("selected"), persistence())),
      ),
    );
    for (const result of results) {
      expect(result).toMatchObject({
        status: "blocked",
        evidence_level: "E0.5",
        applies_change: false,
      });
    }
  });

  test("permits unchanged headings in a body mutation but rejects stale, invalid, and oversized inputs", async () => {
    const heading = {
      ...input(),
      candidate: {
        ...input().candidate,
        installed_body: "# Existing heading\nRequire evidence.",
        proposed_body: "# Existing heading\nRequire portal evidence.",
      },
    };
    const headingResult = await Effect.runPromise(
      runProactiveCorrectionE2(heading, executor("selected"), persistence()),
    );
    expect(headingResult.status).toBe("review_ready");

    const insertedLine = {
      ...input(),
      candidate: {
        ...input().candidate,
        installed_body: "Keep the first rule.\nKeep the last rule.",
        proposed_body: "Keep the first rule.\nAdd one focused rule.\nKeep the last rule.",
      },
    };
    const insertedLineResult = await Effect.runPromise(
      runProactiveCorrectionE2(insertedLine, executor("selected"), persistence()),
    );
    expect(insertedLineResult.status).toBe("review_ready");

    const invalidVerifier = {
      ...input(),
      protocol: {
        ...input().protocol,
        qualified_verifier: {
          ...input().protocol.qualified_verifier,
          status: "rejected",
          reasons: ["misclassified_control"],
        },
      },
    };
    const staleCandidate = {
      ...input(),
      candidate: { ...input().candidate, candidate_revision: revision("a") },
    };
    const oversized = { ...input(), candidate: { ...input().candidate, changed_lines: 41 } };
    const invalidResults = await Promise.all(
      [invalidVerifier, staleCandidate, oversized].map((candidate) =>
        Effect.runPromise(runProactiveCorrectionE2(candidate, executor("selected"), persistence())),
      ),
    );
    for (const result of invalidResults) {
      expect(result.status).not.toBe("review_ready");
      expect(result.applies_change).toBe(false);
    }
    await Promise.all(
      [
        { ...input().controls, active_runs: -1 },
        { ...input().controls, max_concurrency: 33 },
        { ...input().controls, budget_remaining_usd: -1 },
        { ...input().controls, estimated_cost_usd: -1 },
      ].map((controls) =>
        expect(
          Effect.runPromise(
            runProactiveCorrectionE2({ ...input(), controls }, executor("selected"), persistence()),
          ),
        ).rejects.toMatchObject({ code: "INVALID_REQUEST" }),
      ),
    );
  });

  test("maps immutable persistence failures without treating them as a benchmark success", async () => {
    const failing: ProactiveCandidateEvaluationPersistence = {
      persist: () =>
        Effect.fail(
          new ProactiveCandidateEvaluationPersistenceFailure({ message: "immutable conflict" }),
        ),
    };
    await expect(
      Effect.runPromise(runProactiveCorrectionE2(input(), executor("selected"), failing)),
    ).rejects.toMatchObject({ code: "PERSISTENCE_FAILED" });
  });

  test("allows an identical durable retry and surfaces an immutable conflict", async () => {
    const entries = new Map<string, ProactiveCandidateEvaluationRecord>();
    const immutable: ProactiveCandidateEvaluationPersistence = {
      persist: (entry) => {
        const prior = entries.get(entry.evaluation_id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(entry)) {
          return Effect.fail(
            new ProactiveCandidateEvaluationPersistenceFailure({ message: "immutable conflict" }),
          );
        }
        entries.set(entry.evaluation_id, entry);
        return Effect.succeed(entry);
      },
    };
    const first = await Effect.runPromise(
      runProactiveCorrectionE2(input(), executor("selected"), immutable),
    );
    const retry = await Effect.runPromise(
      runProactiveCorrectionE2(input(), executor("selected"), immutable),
    );
    expect(retry).toEqual(first);
    expect(entries).toHaveLength(1);
  });

  test("persists an idempotent, non-applying evaluation through local-store", async () => {
    const sqlite = openDb(":memory:");
    try {
      sqlite
        .query(
          "INSERT INTO correction_signal_candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "candidate-1",
          "candidate-key-1",
          "release-checklist",
          "release-checklist",
          "session-1",
          "E0.5",
          "review_ready",
          null,
          fingerprint("manifest"),
          fingerprint("signal"),
          "{}",
          "2026-07-29T12:00:00.000Z",
          "2026-07-29T12:00:00.000Z",
        );
      const localStorePersistence = makeLocalStoreProactiveCandidateEvaluationPersistence(sqlite);
      const first = await Effect.runPromise(
        runProactiveCorrectionE2(input(), executor("selected"), localStorePersistence),
      );
      const retry = await Effect.runPromise(
        runProactiveCorrectionE2(input(), executor("selected"), localStorePersistence),
      );
      const stored = listLatestCorrectionCandidateEvaluations(sqlite, "candidate-1");

      expect(retry).toEqual(first);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        evidence_level: "E2",
        status: "selected",
        applies_change: "0",
      });
    } finally {
      sqlite.close();
    }
  });
});
