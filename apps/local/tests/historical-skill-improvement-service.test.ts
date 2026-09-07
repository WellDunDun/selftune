import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createOrGetPreparedEvaluationSubmissionDraft,
  createOrGetCorrectionStudy,
  listLatestCorrectionCandidateEvaluations,
  openDb,
} from "@selftune/local-store";
import { replaceBody } from "@selftune/runtime/evolution/deploy-proposal";
import { computeSkillVersionHash } from "@selftune/runtime/utils/skill-discovery";
import { qualifyVerifierInstrument } from "@selftune/skill-intelligence/verifier-instruments";
import { Effect, Layer } from "effect";

import {
  HistoricalSkillImprovement,
  makeHistoricalSkillImprovementLayer,
} from "../src/historical-skill-improvement-service.js";
import { TraceCandidatePreparation } from "../src/trace-candidate-service.js";

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })),
);

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const fingerprint = (value: string): string => `sha256:${hash(value)}`;

function verifier() {
  return qualifyVerifierInstrument({
    instrument: {
      verifier_id: "deterministic-task-check",
      version: "v1",
      kind: "deterministic",
      success_contract: "The task-specific deterministic check passes.",
      check_description: "Runs the frozen task check.",
    },
    evidence: (["known_failure", "known_good", "boundary", "adversarial"] as const).map(
      (label) => ({
        evidence_id: `control-${label}`,
        label,
        expected_decision: label === "known_failure" ? ("reject" as const) : ("accept" as const),
        observed_decision: label === "known_failure" ? ("reject" as const) : ("accept" as const),
        partition: "verifier_calibration" as const,
        candidate_strategy_reference: null,
      }),
    ),
  });
}

describe("historical skill improvement", () => {
  test.each([
    "none",
    "task-case",
    "legacy-episode",
    "malformed-manifest",
    "malformed-verifier",
    "malformed-oversized-task",
    "malformed-empty-task",
    "malformed-task-shape",
    "wrong-verifier",
  ])(
    "composes a review-only historical evaluation with %s regression evidence",
    async (regression) => {
      const database = openDb(":memory:");
      const root = mkdtempSync(join(tmpdir(), "selftune-historical-improvement-"));
      directories.push(root);
      const skillDirectory = join(root, "skills", "release-checklist");
      mkdirSync(skillDirectory, { recursive: true });
      const skillPath = join(skillDirectory, "SKILL.md");
      const installedContent =
        "---\nname: release-checklist\ndescription: Verify releases.\n---\n\n# Release checklist\n\nClaim success after selecting an asset.\n";
      const proposedBody = "Claim success only after the portal confirms the upload.";
      writeFileSync(skillPath, installedContent);
      const installedRevision = computeSkillVersionHash(skillPath);
      if (!installedRevision) throw new Error("fixture revision missing");

      const roles = [
        "calibration_failure",
        "calibration_success",
        "heldout_failure",
        "heldout_success",
      ] as const;
      const entries = roles.map((role, index) => ({
        role,
        source: {
          source_id: "codex",
          source_revision: `source-${index}`,
          trace_id: `${index + 1}`.repeat(32),
          span_id: `${index + 1}`.repeat(16),
          skill_invocation_id: `invocation-${index}`,
        },
        duration_ms: 10,
        input_tokens: 10,
        output_tokens: 10,
        error_count: role.includes("failure") ? 1 : 0,
        tool_call_count: 1,
      }));
      const queries = [
        "calibration failure task",
        "calibration success task",
        "selection failure task",
        "audit success task",
      ];
      const payload = {
        schema_version: 1 as const,
        cohort: {
          schema_version: "1.0.0" as const,
          selector_version: "test/v1",
          pattern: {
            pattern_id: "execution-pattern-test",
            kind: "repeated_correlated_errors" as const,
            skill_id: "release-checklist",
            skill_name: "release-checklist",
          },
          target_skill: {
            skill_id: "release-checklist",
            skill_name: "release-checklist",
            revision: installedRevision,
          },
          excerpt_limit_bytes: 512,
          request_limit_bytes: 8_192,
          entries,
          fingerprint: fingerprint("cohort"),
        },
        candidate: {
          proposal_id: "proposal-1",
          target_revision: installedRevision,
          proposed_body: proposedBody,
          rationale: "Require actual portal confirmation.",
        },
        resolved_evidence: entries.map((entry, index) => ({
          ...entry.source,
          skill_revision: installedRevision,
          query: queries[index],
          should_trigger: true,
        })),
      };
      const draftId = "eval-draft-test";
      await Effect.runPromise(
        createOrGetPreparedEvaluationSubmissionDraft(database, {
          draft_id: draftId,
          pattern_id: payload.cohort.pattern.pattern_id,
          cohort_fingerprint: payload.cohort.fingerprint,
          skill_name: "release-checklist",
          skill_revision: installedRevision,
          payload_json: JSON.stringify(payload),
          prepared_at: "2026-08-06T10:00:00.000Z",
        }),
      );

      if (regression !== "none") {
        const manifest = JSON.stringify(
          regression === "legacy-episode"
            ? { episode: { task: "Confirm the portal reports an uploaded asset." } }
            : {
                task_case: {
                  task_payload: "Confirm the portal reports an uploaded asset.",
                  task_fingerprint: fingerprint("Confirm the portal reports an uploaded asset."),
                },
              },
        );
        const verifierPayload = JSON.stringify({ instrument: verifier().instrument });
        const owner = `skill-${hash("release-checklist").slice(0, 32)}`;
        const timestamp = "2026-08-06T10:00:00.000Z";
        const shared = {
          skill_id: owner,
          skill_name: "release-checklist",
          pre_revision: "a".repeat(64),
          post_revision: "b".repeat(64),
          manifest_json: manifest,
          evidence_level: "E1",
          reason: null,
        };
        await Effect.runPromise(
          createOrGetCorrectionStudy(database, {
            episode: {
              ...shared,
              episode_id: "regression-episode",
              capture_key: "regression-capture",
              skill_path: skillPath,
              harness: "codex",
              source_session_id: "regression-session",
              correction_intent_json: "{}",
              trace_payload_json: "{}",
              status: "promoted",
              captured_at: timestamp,
              created_at: timestamp,
              updated_at: timestamp,
            },
            evidence: {
              skill_id: owner,
              episode_id: "regression-episode",
              evidence_id: "regression-evidence",
              evidence_key: "regression-key",
              evidence_level: "E1",
              status: "qualified",
              reason: null,
              manifest_json: manifest,
              verifier_payload_json: verifierPayload,
              trial_payload_json: "{}",
              recorded_at: timestamp,
            },
            promoted_case: {
              ...shared,
              case_id: "regression-case",
              episode_id: "regression-episode",
              evidence_id: "regression-evidence",
              verifier_payload_json: verifierPayload,
              trial_payload_json: "{}",
              status: "active",
              promoted_at: timestamp,
              created_at: timestamp,
            },
          }),
        );
        if (regression === "malformed-manifest")
          database.run("UPDATE promoted_study_cases SET manifest_json = ? WHERE case_id = ?", [
            "{",
            "regression-case",
          ]);
        if (regression === "malformed-verifier")
          database.run(
            "UPDATE promoted_study_cases SET verifier_payload_json = ? WHERE case_id = ?",
            ["[]", "regression-case"],
          );
        if (regression === "malformed-oversized-task")
          database.run("UPDATE promoted_study_cases SET manifest_json = ? WHERE case_id = ?", [
            JSON.stringify({ task_case: { task_payload: "x".repeat(8_001) } }),
            "regression-case",
          ]);
        if (regression === "malformed-empty-task")
          database.run("UPDATE promoted_study_cases SET manifest_json = ? WHERE case_id = ?", [
            JSON.stringify({
              task_case: { task_payload: "" },
              episode: { task: "Do not fall back from an explicit empty task." },
            }),
            "regression-case",
          ]);
        if (regression === "malformed-task-shape")
          database.run("UPDATE promoted_study_cases SET manifest_json = ? WHERE case_id = ?", [
            JSON.stringify({ task_case: { task_payload: 42 } }),
            "regression-case",
          ]);
        if (regression === "wrong-verifier")
          database.run(
            "UPDATE promoted_study_cases SET verifier_payload_json = ? WHERE case_id = ?",
            [
              JSON.stringify({ instrument: { ...verifier().instrument, version: "different" } }),
              "regression-case",
            ],
          );
      }

      const preparation = Layer.succeed(
        TraceCandidatePreparation,
        TraceCandidatePreparation.of({
          prepare: () =>
            Effect.succeed({
              draft_id: draftId,
              pattern_id: payload.cohort.pattern.pattern_id,
              cohort_fingerprint: payload.cohort.fingerprint,
              target_revision: installedRevision,
              readiness: "review_ready" as const,
              failure_reason: null,
              evidence: { cohort_entries: entries.length, resolved_entries: entries.length },
              candidate: {
                body: proposedBody,
                rationale: payload.candidate.rationale,
                diff: { changed_lines: 1, target_section: "body" },
                uncertainty: [],
              },
            }),
        }),
      );
      const executor = {
        execute: (request: {
          readonly arm: "no_skill" | "current_skill" | "candidate_skill";
          readonly revision: string | null;
        }) =>
          Effect.succeed({
            kind: "scored" as const,
            passed: request.arm === "candidate_skill",
            executed_revision: request.revision,
          }),
      };
      let replayContext:
        | {
            readonly skillName: string;
            readonly currentRevision: string;
            readonly candidateRevision: string;
          }
        | undefined;
      const layer = Layer.provide(
        makeHistoricalSkillImprovementLayer({
          sqlite: database,
          executorFactory: {
            create: (context) => {
              replayContext = context;
              return Effect.succeed(executor);
            },
          },
          searchDirs: [join(root, "skills")],
        }),
        preparation,
      );
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const improvement = yield* HistoricalSkillImprovement;
          return yield* improvement.evaluate({
            pattern_id: payload.cohort.pattern.pattern_id,
            qualified_verifier: verifier(),
            runtime: {
              harness: "codex",
              model: "gpt-5",
              config_digest: fingerprint("runtime"),
            },
            required_scored_repetitions: 3,
            max_attempts_per_arm: 3,
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
            recorded_at: "2026-08-06T10:01:00.000Z",
          });
        }).pipe(Effect.provide(layer), Effect.result),
      );

      if (regression.startsWith("malformed-") || regression === "wrong-verifier") {
        expect(outcome).toMatchObject({
          _tag: "Failure",
          failure: {
            code:
              regression === "wrong-verifier"
                ? "INCOMPATIBLE_REGRESSION_VERIFIER"
                : "INVALID_EVIDENCE",
          },
        });
        expect(replayContext).toBeUndefined();
        expect(listLatestCorrectionCandidateEvaluations(database, draftId)).toHaveLength(0);
        expect(await Bun.file(skillPath).text()).toBe(installedContent);
        database.close();
        return;
      }
      if (outcome._tag === "Failure") throw outcome.failure;
      const result = outcome.success;

      expect(result).toMatchObject({
        draft_id: draftId,
        candidate_id: draftId,
        status: "review_ready",
        evidence_level: "E2",
        reason: "selected",
        cases: {
          calibration: 2,
          selection: regression === "none" ? 1 : 2,
          audit_holdout: 1,
          active_regressions: regression === "none" ? 0 : 1,
        },
        applies_change: false,
      });
      expect(replayContext).toMatchObject({
        skillName: "release-checklist",
        currentRevision: installedRevision,
      });
      expect(replayContext?.candidateRevision).not.toBe(installedRevision);
      expect(await Bun.file(skillPath).text()).toBe(installedContent);
      const evaluations = listLatestCorrectionCandidateEvaluations(database, draftId);
      expect(evaluations).toHaveLength(1);
      const candidateRevision = String(evaluations[0]?.candidate_revision);
      writeFileSync(skillPath, replaceBody(installedContent, proposedBody));
      expect(computeSkillVersionHash(skillPath)).toBe(candidateRevision);
      expect(await Bun.file(skillPath).text()).toContain("portal confirms the upload");
      database.close();
    },
  );

  test("evaluates a neutral historical-task draft and returns a concrete before/after", async () => {
    const database = openDb(":memory:");
    const root = mkdtempSync(join(tmpdir(), "selftune-historical-task-e2-"));
    directories.push(root);
    const skillDirectory = join(root, "skills", "to-issues");
    mkdirSync(skillDirectory, { recursive: true });
    const skillPath = join(skillDirectory, "SKILL.md");
    const installedContent =
      "---\nname: to-issues\ndescription: Break plans into issues.\n---\n\n# To Issues\n\nAsk for approval before drafting.\n";
    const proposedBody =
      "For explicit create requests, produce complete issue drafts without repeating approval.";
    writeFileSync(skillPath, installedContent);
    const installedRevision = computeSkillVersionHash(skillPath);
    if (!installedRevision) throw new Error("fixture revision missing");
    const roles = ["calibration", "calibration", "selection", "audit_holdout"] as const;
    const entries = roles.map((role, index) => ({
      role,
      source: {
        source_id: `source-${index}`,
        source_revision: `revision-${index}`,
        trace_id: `${index + 1}`.repeat(32),
        span_id: `${index + 1}`.repeat(16),
        skill_invocation_id: `invocation-${index}`,
      },
      redacted_task: `Create release issues task ${index}`,
    }));
    const payload = {
      schema_version: 2 as const,
      cohort: {
        schema_version: "1.0.0" as const,
        selector_version: "local-historical-task-quality/v1",
        pattern: {
          pattern_id: "execution-pattern-to-issues",
          kind: "historical_task_quality" as const,
          skill_id: "to-issues",
          skill_name: "to-issues",
        },
        target_skill: {
          skill_id: "to-issues",
          skill_name: "to-issues",
          revision: installedRevision,
        },
        request_limit_bytes: 8_192,
        entries,
        fingerprint: fingerprint("historical-task-cohort"),
      },
      candidate: {
        proposal_id: "historical-task-proposal",
        target_revision: installedRevision,
        proposed_body: proposedBody,
        rationale: "Honor explicit issue-creation approval.",
      },
    };
    const draftId = "eval-draft-historical-task";
    await Effect.runPromise(
      createOrGetPreparedEvaluationSubmissionDraft(database, {
        draft_id: draftId,
        pattern_id: payload.cohort.pattern.pattern_id,
        cohort_fingerprint: payload.cohort.fingerprint,
        skill_name: "to-issues",
        skill_revision: installedRevision,
        payload_json: JSON.stringify(payload),
        prepared_at: "2026-08-06T10:00:00.000Z",
      }),
    );
    const preparation = Layer.succeed(
      TraceCandidatePreparation,
      TraceCandidatePreparation.of({
        prepare: () =>
          Effect.succeed({
            draft_id: draftId,
            pattern_id: payload.cohort.pattern.pattern_id,
            cohort_fingerprint: payload.cohort.fingerprint,
            target_revision: installedRevision,
            readiness: "review_ready" as const,
            failure_reason: null,
            evidence: { cohort_entries: 4, resolved_entries: 4 },
            candidate: {
              body: proposedBody,
              rationale: payload.candidate.rationale,
              diff: { changed_lines: 1, target_section: "Process" },
              uncertainty: [],
            },
          }),
      }),
    );
    const layer = Layer.provide(
      makeHistoricalSkillImprovementLayer({
        sqlite: database,
        executorFactory: {
          create: (context) =>
            Effect.succeed({
              execute: (request) => {
                const passed = request.arm === "candidate_skill";
                context.recordObservation?.({
                  caseId: request.case.case_id,
                  task: request.case.task_payload,
                  arm: request.arm,
                  repetition: request.repetition,
                  passed,
                  output: passed
                    ? "## 1. Release slice\nAcceptance criteria: verified\nBlocked by: none"
                    : "Does the granularity feel right?",
                });
                return Effect.succeed({
                  kind: "scored" as const,
                  passed,
                  executed_revision: request.revision,
                });
              },
            }),
        },
        searchDirs: [join(root, "skills")],
      }),
      preparation,
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const improvement = yield* HistoricalSkillImprovement;
        return yield* improvement.evaluate({
          pattern_id: payload.cohort.pattern.pattern_id,
          qualified_verifier: verifier(),
          runtime: {
            harness: "codex",
            model: "gpt-5.6-luna",
            config_digest: fingerprint("luna-max-runtime"),
          },
          required_scored_repetitions: 3,
          max_attempts_per_arm: 3,
          controls: {
            entitlement_proactive_managed: true,
            proactive_generation_enabled: true,
            managed_execution_enabled: true,
            kill_switch_enabled: false,
            active_runs: 0,
            max_concurrency: 1,
            budget_remaining_usd: 20,
            estimated_cost_usd: 5,
          },
          recorded_at: "2026-08-06T10:01:00.000Z",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toMatchObject({
      status: "review_ready",
      evidence_level: "E2",
      reason: "selected",
      cases: { calibration: 2, selection: 1, audit_holdout: 1 },
      before_after: {
        task: expect.stringContaining("task"),
        current: { passed: false, output: "Does the granularity feel right?" },
        candidate: { passed: true, output: expect.stringContaining("Acceptance criteria") },
      },
    });
    database.close();
  });
});
