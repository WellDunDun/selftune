import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { summarizeReplayRuntimeMetrics } from "../../packages/runtime/create/replay.js";

import { openDb, _setTestDb } from "../../packages/runtime/localdb/db.js";
import { persistPackageCandidateEvaluation } from "../../packages/runtime/create/package-candidate-state.js";
import { runCreatePublish } from "../../packages/runtime/create/publish.js";
import { runPackageSearch } from "../../packages/runtime/create/package-search.js";
import {
  applySearchRunWinner,
  generateSearchRunVariants,
  planVariantCounts,
} from "@selftune/orchestration/search-run";
import {
  readCanonicalPackageEvaluationArtifact,
  writeCanonicalPackageEvaluationArtifact,
} from "../../packages/runtime/testing-readiness.js";
import type {
  CreateCheckResult,
  CreatePackageEvaluationResult,
} from "../../packages/runtime/types.js";
import { runVerify } from "../../packages/runtime/verify.js";

let tempRoot = "";
let originalConfigDir: string | undefined;

function makeReadyCheck(skillPath: string): CreateCheckResult {
  return {
    skill: "research-assistant",
    skill_dir: tempRoot,
    skill_path: skillPath,
    ok: true,
    state: "ready_to_publish",
    next_command: `selftune publish --skill-path ${skillPath}`,
    spec_validation: {
      ok: true,
      issues: [],
      raw_stdout: "",
      raw_stderr: "",
      exit_code: 0,
      validator: "skills-ref",
      command: `uvx skills-ref validate ${tempRoot}`,
    },
    readiness: {
      ok: true,
      state: "ready_to_publish",
      summary: "ready",
      next_command: `selftune publish --skill-path ${skillPath}`,
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
        evals_present: true,
        unit_tests_present: true,
        routing_replay_ready: true,
        routing_replay_recorded: true,
        package_replay_ready: true,
        baseline_present: true,
      },
      skill_name: "research-assistant",
      skill_dir: tempRoot,
      skill_path: skillPath,
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
  };
}

function makeEvaluation(
  skillPath: string,
  packageFingerprint: string,
  overrides: {
    replayPassRate?: number;
    baselineLift?: number;
    bodyQualityScore?: number;
    evaluationSource?: "fresh" | "candidate_cache";
  } = {},
): CreatePackageEvaluationResult {
  const replayPassRate = overrides.replayPassRate ?? 1;
  const baselineLift = overrides.baselineLift ?? 0.1;
  const bodyQualityScore = overrides.bodyQualityScore ?? 0.9;

  return {
    summary: {
      skill_name: "research-assistant",
      skill_path: skillPath,
      mode: "package" as const,
      package_fingerprint: packageFingerprint,
      evaluation_source: overrides.evaluationSource ?? ("fresh" as const),
      status: "passed" as const,
      evaluation_passed: true,
      next_command: `selftune publish --skill-path ${skillPath}`,
      replay: {
        mode: "package" as const,
        validation_mode: "host_replay" as const,
        agent: "claude",
        proposal_id: "proposal-root",
        fixture_id: "fixture-root",
        total: 2,
        passed: replayPassRate === 1 ? 2 : 1,
        failed: replayPassRate === 1 ? 0 : 1,
        pass_rate: replayPassRate,
      },
      routing: {
        mode: "routing" as const,
        validation_mode: "host_replay" as const,
        agent: "claude",
        proposal_id: "proposal-routing",
        fixture_id: "fixture-routing",
        total: 2,
        passed: 2,
        failed: 0,
        pass_rate: 1,
      },
      baseline: {
        mode: "package" as const,
        baseline_pass_rate: 0.4,
        with_skill_pass_rate: 0.4 + baselineLift,
        lift: baselineLift,
        adds_value: baselineLift > 0,
        measured_at: "2026-04-15T09:00:00.000Z",
      },
      body: {
        structural_valid: true,
        structural_reason: "ok",
        quality_score: bodyQualityScore,
        quality_reason: "clear",
        quality_threshold: 0.6,
        quality_passed: true,
        valid: true,
      },
      unit_tests: {
        total: 2,
        passed: 2,
        failed: 0,
        pass_rate: 1,
        run_at: "2026-04-15T09:10:00.000Z",
        failing_tests: [],
      },
    },
    replay: {
      skill: "research-assistant",
      skill_path: skillPath,
      mode: "package" as const,
      agent: "claude",
      proposal_id: "proposal-root",
      total: 2,
      passed: replayPassRate === 1 ? 2 : 1,
      failed: replayPassRate === 1 ? 0 : 1,
      pass_rate: replayPassRate,
      fixture_id: "fixture-root",
      results: [],
      runtime_metrics: summarizeReplayRuntimeMetrics([]),
    },
    baseline: {
      skill_name: "research-assistant",
      mode: "package" as const,
      baseline_pass_rate: 0.4,
      with_skill_pass_rate: 0.4 + baselineLift,
      lift: baselineLift,
      adds_value: baselineLift > 0,
      per_entry: [],
      measured_at: "2026-04-15T09:00:00.000Z",
    },
  };
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "selftune-package-lifecycle-"));
  originalConfigDir = process.env.SELFTUNE_CONFIG_DIR;
  process.env.SELFTUNE_CONFIG_DIR = join(tempRoot, ".selftune");
  _setTestDb(openDb(":memory:"));
});

afterEach(() => {
  _setTestDb(null);
  if (originalConfigDir === undefined) delete process.env.SELFTUNE_CONFIG_DIR;
  else process.env.SELFTUNE_CONFIG_DIR = originalConfigDir;
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

describe("e2e: package lifecycle", () => {
  test("verify, improve, and publish flow through the measured package lifecycle", async () => {
    const db = openDb(":memory:");
    _setTestDb(db);

    const skillDir = join(tempRoot, "research-assistant");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(
      skillPath,
      `# Research Assistant

Assist with project research.

## Workflow Routing

| Trigger | Workflow |
| --- | --- |
| summarize research | default |

## Instructions

1. Read the request.
2. Answer directly.
`,
      "utf-8",
    );
    writeFileSync(join(skillDir, "selftune.create.json"), "{}", "utf-8");

    const readinessSequence: CreateCheckResult[] = [
      {
        ...makeReadyCheck(skillPath),
        ok: false,
        state: "needs_evals",
        next_command: "selftune verify --skill-path placeholder",
      },
      {
        ...makeReadyCheck(skillPath),
        ok: false,
        state: "needs_unit_tests",
        next_command: "selftune verify --skill-path placeholder",
      },
      makeReadyCheck(skillPath),
    ];
    const verificationCommands: string[][] = [];

    const verifyResult = await runVerify(
      {
        skillPath,
        evalSetPath: join(skillDir, "evals.json"),
      },
      {
        computeCreateCheckResult: async () =>
          readinessSequence.shift() ?? makeReadyCheck(skillPath),
        runSelftuneSubCommand: (command) => {
          verificationCommands.push(command);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        runCreateReport: async () => makeEvaluation(skillPath, "pkg_sha256_root0001"),
      },
    );

    expect(verifyResult.verified).toBe(true);
    expect(verificationCommands).toEqual([
      [
        "eval",
        "generate",
        "--skill",
        "research-assistant",
        "--skill-path",
        skillPath,
        "--auto-synthetic",
      ],
      [
        "eval",
        "unit-test",
        "--skill",
        "research-assistant",
        "--generate",
        "--eval-set",
        join(skillDir, "evals.json"),
        "--skill-path",
        skillPath,
      ],
    ]);

    persistPackageCandidateEvaluation(makeEvaluation(skillPath, "pkg_sha256_root0001"), db);
    writeCanonicalPackageEvaluationArtifact(
      "research-assistant",
      makeEvaluation(skillPath, "pkg_sha256_root0001"),
    );

    const routingVariantPath = join(tempRoot, "routing-variant", "SKILL.md");
    const bodyVariantPath = join(tempRoot, "body-variant", "SKILL.md");
    mkdirSync(join(tempRoot, "routing-variant"), { recursive: true });
    mkdirSync(join(tempRoot, "body-variant"), { recursive: true });
    writeFileSync(
      routingVariantPath,
      readFileSync(skillPath, "utf-8").replace(
        "| summarize research | default |",
        "| summarize research | default |\n| draft research plan | default |",
      ),
      "utf-8",
    );
    writeFileSync(
      bodyVariantPath,
      readFileSync(skillPath, "utf-8").replace(
        "2. Answer directly.",
        "2. Gather the relevant context.\n3. Verify the answer before replying.",
      ),
      "utf-8",
    );

    const generatedVariants = await generateSearchRunVariants(
      skillPath,
      "research-assistant",
      planVariantCounts("both", 2, {
        weakness_source: "accepted_frontier",
        routing_weakness: 0.9,
        body_weakness: 0.8,
      }),
      "claude",
      db,
      {
        extractMutationWeaknesses: () => ({
          replayFailureSamples: ["draft research plan"],
          routingFailureSamples: [],
          bodyQualityScore: 0.45,
          gradingPassRateDelta: -0.2,
          gradingFailurePatterns: ["missing verification step"],
        }),
        generateReflectiveRoutingMutations: async () => [
          {
            variantSkillPath: routingVariantPath,
            mutationSurface: "routing",
            mutationDescription: "Reflective routing",
            parentFingerprint: "parent",
          },
        ],
        generateReflectiveBodyMutations: async () => [
          {
            variantSkillPath: bodyVariantPath,
            mutationSurface: "body",
            mutationDescription: "Reflective body",
            parentFingerprint: "parent",
          },
        ],
        generateTargetedRoutingMutations: () => [],
        generateTargetedBodyMutations: () => [],
        generateRoutingMutations: async () => [],
        generateBodyMutations: async () => [],
      },
    );

    const searchResult = await runPackageSearch({
      skill_name: "research-assistant",
      candidate_paths: generatedVariants.generated_variants.map((variant) => ({
        skill_path: variant.skill_path,
        fingerprint: variant.fingerprint,
        mutation_surface: variant.mutation_surface,
      })),
      db,
      evaluator_deps: {
        runCreateReplay: async ({ skillPath: evaluatedSkillPath, mode }) => ({
          skill: "research-assistant",
          skill_path: evaluatedSkillPath,
          mode,
          agent: "claude",
          proposal_id: "proposal-package",
          total: 2,
          passed: 2,
          failed: 0,
          pass_rate: 1,
          fixture_id: "fixture-package",
          results: [],
          runtime_metrics: summarizeReplayRuntimeMetrics([]),
        }),
        runCreateBaseline: async ({
          skillPath: evaluatedSkillPath,
          mode,
          withSkillReplayResult,
        }) => {
          assert(
            withSkillReplayResult,
            "Package evaluation supplies the measured with-skill replay",
          );
          const lift =
            evaluatedSkillPath === routingVariantPath
              ? 0.3
              : evaluatedSkillPath === bodyVariantPath
                ? 0.32
                : 0.5;
          return {
            skill_name: "research-assistant",
            mode,
            baseline_pass_rate: 0.4,
            with_skill_pass_rate: 0.4 + lift,
            lift,
            adds_value: true,
            per_entry: [],
            measured_at: "2026-04-15T09:00:00.000Z",
            runtime_metrics: {
              with_skill: withSkillReplayResult.runtime_metrics,
              without_skill: summarizeReplayRuntimeMetrics([]),
            },
          };
        },
        assessBodyQuality: async (evaluatedSkillPath) => ({
          score:
            evaluatedSkillPath === routingVariantPath
              ? 0.72
              : evaluatedSkillPath === bodyVariantPath
                ? 0.95
                : 0.99,
          reason: "clear",
        }),
        readCanonicalPackageEvaluationArtifact: () => null,
        readCanonicalUnitTestRunResult: () => null,
      },
    });

    expect(searchResult.candidates_evaluated).toBe(3);
    expect(searchResult.winner_candidate_id).not.toBeNull();
    expect(
      searchResult.provenance.evaluation_summaries.some((summary) =>
        summary.rationale.includes("Merged accepted routing"),
      ),
    ).toBe(true);

    const applyResult = applySearchRunWinner(
      "research-assistant",
      skillPath,
      searchResult.winner_candidate_id,
    );

    expect(applyResult.applied_winner).toBe(true);
    expect(readFileSync(skillPath, "utf-8")).toContain("Verify the answer before replying.");

    const publishResult = await runCreatePublish(
      {
        skillPath,
        watch: true,
      },
      {
        computeCreateCheckResult: async () => makeReadyCheck(skillPath),
        runCreatePackageEvaluation: async () =>
          readCanonicalPackageEvaluationArtifact("research-assistant") ??
          makeEvaluation(skillPath, "pkg_sha256_promoted0001", {
            evaluationSource: "candidate_cache",
            baselineLift: 0.5,
            bodyQualityScore: 0.99,
          }),
        spawnSync: () => ({
          stdout: new TextEncoder().encode(
            JSON.stringify({
              snapshot: {
                timestamp: "2026-04-15T12:30:00.000Z",
                skill_name: "research-assistant",
                window_sessions: 20,
                skill_checks: 5,
                pass_rate: 0.95,
                false_negative_rate: 0.05,
                by_invocation_type: {
                  explicit: { passed: 2, total: 2 },
                  implicit: { passed: 2, total: 2 },
                  contextual: { passed: 1, total: 1 },
                  negative: { passed: 0, total: 0 },
                },
                regression_detected: false,
                baseline_pass_rate: 0.8,
              },
              alert: null,
              rolledBack: false,
              recommendation: 'Skill "research-assistant" is stable.',
              recommended_command: null,
              gradeAlert: null,
              gradeRegression: null,
            }),
          ),
          stderr: new Uint8Array(),
          exitCode: 0,
        }),
      },
    );

    expect(publishResult.published).toBe(true);
    expect(publishResult.watch_started).toBe(true);
    expect(publishResult.watch_gate_passed).toBe(true);
    expect(publishResult.next_command).toBeNull();
    expect(publishResult.package_evaluation?.watch?.snapshot.pass_rate).toBe(0.95);
  });
});
