import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listCorrectionSignalCandidates,
  listCorrectionStudyDrafts,
  openDb,
} from "@selftune/local-store";
import { captureCorrectionSignalStudies } from "@selftune/orchestration/orchestrate/correction-signal-studies";
import * as Effect from "effect/Effect";

import { captureManagedCorrectionStudy } from "../src/correction-study-service.js";
import {
  makeLocalStoreProactiveCandidateEvaluationPersistence,
  runProactiveCorrectionE2,
} from "../src/proactive-correction-e2-service.js";
import { qualifyVerifierInstrument } from "@selftune/skill-intelligence/verifier-instruments";

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })),
);

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fingerprint = (value: string) => `sha256:${hash(value)}`;
const revision = (value: string) => hash(value);
const skillId = (name: string) => `skill-${hash(name).slice(0, 32)}`;

function verifier() {
  return qualifyVerifierInstrument({
    instrument: {
      verifier_id: "portal-check",
      version: "v1",
      kind: "deterministic",
      success_contract: "Portal status proves the claim.",
      check_description: "Checks portal status.",
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

describe("correction learning E2 acceptance", () => {
  test("captures a bounded correction, promotes its regression, then blocks a reintroducing candidate", async () => {
    const sqlite = openDb(":memory:");
    const directory = mkdtempSync(join(tmpdir(), "selftune-e2-"));
    directories.push(directory);
    const skillPath = join(directory, "SKILL.md");
    const before = "# Release checklist\n\nClaim upload success when an asset is selected.\n";
    const after =
      "# Release checklist\n\nClaim upload success only after the portal confirms it.\n";
    writeFileSync(skillPath, before);
    const preRevision = revision(before);
    writeFileSync(skillPath, after);
    const postRevision = revision(after);
    const id = skillId("release-checklist");

    const signal = {
      candidate_id: "signal-1",
      evidence_level: "E0.5" as const,
      review_status: "review_required" as const,
      reason: "User corrected the skill after a false upload claim.",
      skill: { name: "release-checklist", pre_revision: preRevision, post_revision: postRevision },
      source: { session_id: "session-1", prompt_id: "prompt-2", raw_source_ref_digest: null },
      raw_edit_digest: fingerprint(after),
      deferred_skill_names: null,
      correction_intent: "Require portal confirmation before declaring upload success.",
    };
    const captured = await captureCorrectionSignalStudies({
      database: sqlite,
      now: () => "2026-07-29T12:00:00.000Z",
      discoverPage: () => ({ items: [signal], next_cursor: null }),
    });
    expect(captured).toMatchObject({ persisted: 1, drafted: 1, errors: 0 });
    expect(Effect.runSync(listCorrectionSignalCandidates(sqlite, { skill_id: id }))).toHaveLength(
      1,
    );
    expect(Effect.runSync(listCorrectionStudyDrafts(sqlite, { skill_id: id }))).toHaveLength(1);

    const task = "Verify the portal before claiming the upload succeeded.";
    const replay = await Effect.runPromise(
      captureManagedCorrectionStudy(
        sqlite,
        {
          episode: {
            skill_id: id,
            skill_name: "release-checklist",
            skill_path: skillPath,
            task,
            observed_failure: "A selected asset was treated as uploaded.",
            correction_intent: signal.correction_intent,
            pre_edit_revision: preRevision,
            post_edit_revision: postRevision,
            bounded_diff: "One body-line correction.",
            provenance: { harness: "codex", trace_id: "trace-1", session_id: "session-1" },
            captured_at: "2026-07-29T12:00:00.000Z",
          },
          task_case: {
            case_id: "regression-1",
            task_payload: task,
            task_fingerprint: fingerprint(task),
          },
          current_revision: postRevision,
          runtime: { harness: "codex", model: "gpt-5", config_digest: fingerprint("runtime") },
          qualified_verifier: verifier(),
          required_scored_repetitions: 3,
          max_attempts_per_arm: 3,
        },
        {
          execute: (request) =>
            Effect.succeed({
              kind: "scored" as const,
              passed: request.arm === "post_edit",
              executed_revision: request.revision,
            }),
        },
      ),
    );
    expect(replay).toMatchObject({
      evidence_level: "E1",
      status: "promoted",
      regression_case: { status: "active" },
      applies_change: false,
    });

    const reintroduced = "# Release checklist\n\nClaim upload success when an asset is selected.\n";
    const candidateRevision = revision(reintroduced);
    const calibration = "calibration";
    const audit = "audit";
    const result = await Effect.runPromise(
      runProactiveCorrectionE2(
        {
          candidate: {
            candidate_id: "signal-1",
            skill_id: id,
            skill_name: "release-checklist",
            candidate_kind: "existing_skill_body_mutation",
            installed_body: after,
            proposed_body: reintroduced,
            installed_revision: postRevision,
            candidate_revision: candidateRevision,
            changed_lines: 1,
            cross_file_edits: false,
            protected_metadata_changed: false,
          },
          observed_installed_revision: postRevision,
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
                task_payload: task,
                task_fingerprint: fingerprint(task),
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
            qualified_verifier: verifier(),
            current_revision: postRevision,
            installed_current_revision: postRevision,
            candidate_revision: candidateRevision,
            runtime: { harness: "codex", model: "gpt-5", config_digest: fingerprint("runtime") },
            required_scored_repetitions: 3,
            max_attempts_per_arm: 3,
          },
          active_regression_cases: [
            {
              case_id: "regression-1",
              skill_id: id,
              status: "active",
              task_fingerprint: fingerprint(task),
            },
          ],
          controls: {
            entitlement_proactive_managed: true,
            proactive_generation_enabled: true,
            managed_execution_enabled: true,
            kill_switch_enabled: false,
            active_runs: 0,
            max_concurrency: 1,
            budget_remaining_usd: 1,
            estimated_cost_usd: 0.1,
          },
          recorded_at: "2026-07-29T12:01:00.000Z",
        },
        {
          execute: (request) =>
            Effect.succeed({
              kind: "scored" as const,
              passed: request.arm !== "candidate_skill" || request.case.case_id !== "regression-1",
              executed_revision: request.revision,
            }),
        },
        makeLocalStoreProactiveCandidateEvaluationPersistence(sqlite),
      ),
    );
    expect(result).toMatchObject({
      status: "not_ready",
      reason: "regression_case_failed",
      evidence_level: "E0.5",
      applies_change: false,
    });
    expect(revision(after)).toBe(postRevision);
    sqlite.close();
  });
});
