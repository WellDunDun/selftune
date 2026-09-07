import assert from "node:assert/strict";
import type { CreatePackageEvaluationResult } from "../../packages/runtime/create/package-evaluator.js";
import { summarizeReplayRuntimeMetrics } from "../../packages/runtime/create/replay.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../packages/runtime/localdb/db.js";
import {
  listPackageCandidates,
  persistPackageCandidateEvaluation,
} from "../../packages/runtime/create/package-candidate-state.js";
import {
  insertSearchRun,
  readSearchRuns,
  runPackageSearch,
} from "../../packages/runtime/create/package-search.js";
import type { PackageSearchRunResult } from "../../packages/runtime/types.js";

let db: Database;
let tempRoot: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  db = openDb(":memory:");
  tempRoot = mkdtempSync(join(tmpdir(), "selftune-package-search-"));
  originalConfigDir = process.env.SELFTUNE_CONFIG_DIR;
  process.env.SELFTUNE_CONFIG_DIR = join(tempRoot, ".selftune");
});

afterEach(() => {
  db.close();
  if (originalConfigDir === undefined) delete process.env.SELFTUNE_CONFIG_DIR;
  else process.env.SELFTUNE_CONFIG_DIR = originalConfigDir;
  rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// insertSearchRun / readSearchRuns (persistence)
// ---------------------------------------------------------------------------

function makeSearchRun(overrides: Partial<PackageSearchRunResult> = {}): PackageSearchRunResult {
  return {
    search_id: "sr-001",
    skill_name: "test-skill",
    parent_candidate_id: null,
    candidates_evaluated: 0,
    winner_candidate_id: null,
    winner_rationale: null,
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:01:00.000Z",
    provenance: {
      frontier_size: 0,
      parent_selection_method: "none_first_run",
      candidate_fingerprints: [],
      evaluation_summaries: [],
    },
    ...overrides,
  };
}

function writeSkillVariant(
  dirName: string,
  bodyNote: string,
  options: { routingTrigger?: string } = {},
): string {
  const skillDir = join(tempRoot, dirName);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  const routingTrigger = options.routingTrigger ?? "create task";
  writeFileSync(
    skillPath,
    `# Test Skill

A test package variant. ${bodyNote}

## Workflow Routing

| Trigger | Workflow |
| --- | --- |
| ${routingTrigger} | default |

## Instructions

1. Follow the workflow.
`,
    "utf-8",
  );
  return skillPath;
}

function makeEvaluation(
  packageFingerprint: string,
  options: {
    skillName?: string;
    skillPath?: string;
    replayPassRate?: number;
    baselineLift?: number;
  } = {},
) {
  const skillName = options.skillName ?? "test-skill";
  const skillPath = options.skillPath ?? `/tmp/${skillName}/SKILL.md`;
  const replayPassRate = options.replayPassRate ?? 1;
  const baselineLift = options.baselineLift ?? 0.1;
  const evaluation: CreatePackageEvaluationResult = {
    summary: {
      skill_name: skillName,
      skill_path: skillPath,
      mode: "package" as const,
      package_fingerprint: packageFingerprint,
      evaluation_source: "fresh" as const,
      status: "passed" as const,
      evaluation_passed: true,
      next_command: null,
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
        quality_score: 0.9,
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
      skill: skillName,
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
      skill_name: skillName,
      mode: "package" as const,
      baseline_pass_rate: 0.4,
      with_skill_pass_rate: 0.4 + baselineLift,
      lift: baselineLift,
      adds_value: baselineLift > 0,
      per_entry: [],
      measured_at: "2026-04-15T09:00:00.000Z",
    },
  };
  return evaluation;
}

describe("search run persistence", () => {
  test.each(["null", "{}", '{"frontier_size":"two"}'])(
    "rejects malformed persisted provenance: %s",
    (provenance) => {
      insertSearchRun(db, makeSearchRun());
      db.query("UPDATE package_search_runs SET provenance_json = ?").run(provenance);
      expect(() => readSearchRuns(db, "test-skill")).toThrow();
    },
  );

  test("insertSearchRun + readSearchRuns roundtrip", () => {
    const run = makeSearchRun({
      search_id: "sr-001",
      parent_candidate_id: "p-1",
      candidates_evaluated: 3,
      winner_candidate_id: "w-1",
      winner_rationale: "improved",
      provenance: {
        frontier_size: 2,
        parent_selection_method: "highest_ranked_frontier",
        candidate_fingerprints: ["fp1", "fp2", "fp3"],
        surface_plan: {
          routing_count: 2,
          body_count: 1,
          weakness_source: "accepted_frontier",
          routing_weakness: 0.8,
          body_weakness: 0.2,
        },
        evaluation_summaries: [
          { candidate_id: "c1", decision: "rejected", rationale: "no improvement" },
          { candidate_id: "c2", decision: "accepted", rationale: "better" },
        ],
      },
    });

    insertSearchRun(db, run);
    const rows = readSearchRuns(db, "test-skill");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(run);
  });

  test("readSearchRuns returns newest first", () => {
    insertSearchRun(
      db,
      makeSearchRun({
        search_id: "sr-old",
        started_at: "2026-01-01T00:00:00.000Z",
        completed_at: "2026-01-01T00:01:00.000Z",
      }),
    );

    insertSearchRun(
      db,
      makeSearchRun({
        search_id: "sr-new",
        candidates_evaluated: 2,
        started_at: "2026-01-02T00:00:00.000Z",
        completed_at: "2026-01-02T00:01:00.000Z",
      }),
    );

    const rows = readSearchRuns(db, "test-skill");
    expect(rows).toHaveLength(2);
    expect(rows[0].search_id).toBe("sr-new");
    expect(rows[1].search_id).toBe("sr-old");
  });

  test("readSearchRuns returns empty for unknown skill", () => {
    insertSearchRun(db, makeSearchRun());
    const rows = readSearchRuns(db, "other-skill");
    expect(rows).toHaveLength(0);
  });

  test("provenance fields survive serialization roundtrip", () => {
    const run = makeSearchRun({
      search_id: "sr-prov",
      provenance: {
        frontier_size: 5,
        parent_selection_method: "highest_ranked_frontier",
        candidate_fingerprints: ["fp-a", "fp-b"],
        evaluation_summaries: [
          { candidate_id: "c-a", decision: "accepted", rationale: "replay +10%" },
          { candidate_id: "c-b", decision: "rejected", rationale: "baseline regression" },
        ],
      },
    });

    insertSearchRun(db, run);
    const [restored] = readSearchRuns(db, "test-skill");
    expect(restored.provenance.frontier_size).toBe(5);
    expect(restored.provenance.parent_selection_method).toBe("highest_ranked_frontier");
    expect(restored.provenance.candidate_fingerprints).toEqual(["fp-a", "fp-b"]);
    expect(restored.provenance.evaluation_summaries).toHaveLength(2);
    expect(restored.provenance.evaluation_summaries[0].decision).toBe("accepted");
  });

  test("winner fields are nullable", () => {
    const run = makeSearchRun({
      search_id: "sr-noop",
      winner_candidate_id: null,
      winner_rationale: null,
    });

    insertSearchRun(db, run);
    const [restored] = readSearchRuns(db, "test-skill");
    expect(restored.winner_candidate_id).toBeNull();
    expect(restored.winner_rationale).toBeNull();
  });

  test("multiple search runs accumulate for same skill", () => {
    for (let i = 0; i < 5; i++) {
      insertSearchRun(
        db,
        makeSearchRun({
          search_id: `sr-${i}`,
          started_at: `2026-01-0${i + 1}T00:00:00.000Z`,
          completed_at: `2026-01-0${i + 1}T00:01:00.000Z`,
        }),
      );
    }
    const rows = readSearchRuns(db, "test-skill");
    expect(rows).toHaveLength(5);
    // Newest first
    expect(rows[0].search_id).toBe("sr-4");
    expect(rows[4].search_id).toBe("sr-0");
  });
});

describe("runPackageSearch", () => {
  test("selects an accepted winner even when replay is unchanged but baseline lift improves", async () => {
    persistPackageCandidateEvaluation(makeEvaluation("pkg_sha256_parent0001"), db);

    const variantAPath = writeSkillVariant("variant-a", "Same measured value.");
    const variantBPath = writeSkillVariant("variant-b", "Higher baseline lift.");
    const replayByPath = new Map([
      [variantAPath, 1],
      [variantBPath, 1],
    ]);
    const liftByPath = new Map([
      [variantAPath, 0.1],
      [variantBPath, 0.45],
    ]);

    const result = await runPackageSearch({
      skill_name: "test-skill",
      candidate_paths: [
        { skill_path: variantAPath, fingerprint: "pkg_sha256_varianta0001" },
        { skill_path: variantBPath, fingerprint: "pkg_sha256_variantb0001" },
      ],
      db,
      evaluator_deps: {
        runCreateReplay: async ({ skillPath, mode }) => ({
          skill: "ignored-temp-name",
          skill_path: skillPath,
          mode,
          agent: "claude",
          proposal_id: `proposal-${mode}`,
          total: 2,
          passed: 2,
          failed: 0,
          pass_rate: replayByPath.get(skillPath) ?? 1,
          fixture_id: `fixture-${mode}`,
          results: [],
          runtime_metrics: summarizeReplayRuntimeMetrics([]),
        }),
        runCreateBaseline: async ({ skillPath, mode, withSkillReplayResult }) => {
          assert.ok(withSkillReplayResult);
          const lift = liftByPath.get(skillPath) ?? 0.1;
          return {
            skill_name: "ignored-temp-name",
            mode,
            baseline_pass_rate: 0.4,
            with_skill_pass_rate: 0.4 + lift,
            lift,
            adds_value: true,
            per_entry: [],
            measured_at: "2026-04-15T09:00:00.000Z",
            runtime_metrics: {
              with_skill: withSkillReplayResult.runtime_metrics,
              without_skill: {
                eval_runs: 0,
                usage_observations: 0,
                total_duration_ms: 0,
                avg_duration_ms: 0,
                total_input_tokens: null,
                total_output_tokens: null,
                total_cache_creation_input_tokens: null,
                total_cache_read_input_tokens: null,
                total_cost_usd: null,
                total_turns: null,
              },
            },
          };
        },
        assessBodyQuality: async () => ({ score: 0.9, reason: "clear" }),
        readCanonicalPackageEvaluationArtifact: () => null,
        readCanonicalUnitTestRunResult: () => null,
      },
    });

    expect(result.candidates_evaluated).toBe(2);
    expect(result.winner_candidate_id).not.toBeNull();
    expect(result.winner_rationale).toContain("baseline lift");

    const candidates = listPackageCandidates("test-skill", db);
    expect(candidates).toHaveLength(3);
    expect(candidates[1]?.skill_name).toBe("test-skill");
    expect(candidates[2]?.skill_name).toBe("test-skill");
    expect(candidates[1]?.latest_acceptance_decision).toBe("rejected");
    expect(candidates[2]?.latest_acceptance_decision).toBe("accepted");
    expect(result.winner_candidate_id).toBe(candidates[2]?.candidate_id);
  });

  test("returns no winner when no evaluated candidate beats the accepted frontier", async () => {
    persistPackageCandidateEvaluation(makeEvaluation("pkg_sha256_parent0002"), db);
    const variantPath = writeSkillVariant("variant-no-win", "No measured improvement.");

    const result = await runPackageSearch({
      skill_name: "test-skill",
      candidate_paths: [{ skill_path: variantPath, fingerprint: "pkg_sha256_variantnowin0001" }],
      db,
      evaluator_deps: {
        runCreateReplay: async ({ skillPath, mode }) => ({
          skill: "ignored-temp-name",
          skill_path: skillPath,
          mode,
          agent: "claude",
          proposal_id: `proposal-${mode}`,
          total: 2,
          passed: 2,
          failed: 0,
          pass_rate: 1,
          fixture_id: `fixture-${mode}`,
          results: [],
          runtime_metrics: summarizeReplayRuntimeMetrics([]),
        }),
        runCreateBaseline: async ({ mode }) => ({
          skill_name: "ignored-temp-name",
          mode,
          baseline_pass_rate: 0.4,
          with_skill_pass_rate: 0.5,
          lift: 0.1,
          adds_value: true,
          per_entry: [],
          measured_at: "2026-04-15T09:00:00.000Z",
        }),
        assessBodyQuality: async () => ({ score: 0.9, reason: "clear" }),
        readCanonicalPackageEvaluationArtifact: () => null,
        readCanonicalUnitTestRunResult: () => null,
      },
    });

    expect(result.candidates_evaluated).toBe(1);
    expect(result.winner_candidate_id).toBeNull();
    expect(result.winner_rationale).toBeNull();
  });

  test("evaluates and can select a merged routing/body candidate after complementary accepted wins", async () => {
    persistPackageCandidateEvaluation(makeEvaluation("pkg_sha256_parent0003"), db);

    const routingVariantPath = writeSkillVariant("variant-routing", "Routing-focused variant.", {
      routingTrigger: "routing-only trigger",
    });
    const bodyVariantPath = writeSkillVariant("variant-body", "Body-focused variant.", {
      routingTrigger: "body-only trigger",
    });
    const originalBodyVariantContent = readFileSync(bodyVariantPath, "utf-8");

    const replayByPath = new Map<string, number>([
      [routingVariantPath, 1],
      [bodyVariantPath, 1],
    ]);
    const liftByPath = new Map<string, number>([
      [routingVariantPath, 0.3],
      [bodyVariantPath, 0.32],
    ]);

    const mergedBodyScores = new Map<string, number>([
      [routingVariantPath, 0.7],
      [bodyVariantPath, 0.96],
    ]);
    const evaluatedSkillPaths: string[] = [];

    const result = await runPackageSearch({
      skill_name: "test-skill",
      candidate_paths: [
        {
          skill_path: routingVariantPath,
          fingerprint: "pkg_sha256_variantmerge_routing0001",
          mutation_surface: "routing",
        },
        {
          skill_path: bodyVariantPath,
          fingerprint: "pkg_sha256_variantmerge_body0001",
          mutation_surface: "body",
        },
      ],
      db,
      evaluator_deps: {
        runCreateReplay: async ({ skillPath, mode }) => {
          evaluatedSkillPaths.push(skillPath);
          return {
            skill: "ignored-temp-name",
            skill_path: skillPath,
            mode,
            agent: "claude",
            proposal_id: `proposal-${mode}`,
            total: 2,
            passed: 2,
            failed: 0,
            pass_rate: replayByPath.get(skillPath) ?? 1,
            fixture_id: `fixture-${mode}`,
            results: [],
            runtime_metrics: summarizeReplayRuntimeMetrics([]),
          };
        },
        runCreateBaseline: async ({ skillPath, mode, withSkillReplayResult }) => {
          assert.ok(withSkillReplayResult);
          const lift = liftByPath.get(skillPath) ?? 0.48;
          return {
            skill_name: "ignored-temp-name",
            mode,
            baseline_pass_rate: 0.4,
            with_skill_pass_rate: 0.4 + lift,
            lift,
            adds_value: true,
            per_entry: [],
            measured_at: "2026-04-15T09:00:00.000Z",
            runtime_metrics: {
              with_skill: withSkillReplayResult.runtime_metrics,
              without_skill: {
                eval_runs: 0,
                usage_observations: 0,
                total_duration_ms: 0,
                avg_duration_ms: 0,
                total_input_tokens: null,
                total_output_tokens: null,
                total_cache_creation_input_tokens: null,
                total_cache_read_input_tokens: null,
                total_cost_usd: null,
                total_turns: null,
              },
            },
          };
        },
        assessBodyQuality: async (skillPath) => ({
          score: mergedBodyScores.get(skillPath) ?? 0.98,
          reason: "clear",
        }),
        readCanonicalPackageEvaluationArtifact: () => null,
        readCanonicalUnitTestRunResult: () => null,
      },
    });

    expect(result.candidates_evaluated).toBe(3);
    expect(result.winner_candidate_id).not.toBeNull();
    expect(result.provenance.evaluation_summaries).toHaveLength(3);
    expect(
      result.provenance.evaluation_summaries.some((summary) =>
        summary.rationale.includes("Merged accepted routing"),
      ),
    ).toBe(true);

    expect(readFileSync(bodyVariantPath, "utf-8")).toBe(originalBodyVariantContent);

    const mergedSkillPath = evaluatedSkillPaths.find(
      (skillPath) => skillPath !== routingVariantPath && skillPath !== bodyVariantPath,
    );
    expect(mergedSkillPath).toBeDefined();
    expect(mergedSkillPath).not.toBe(bodyVariantPath);
    expect(readFileSync(mergedSkillPath!, "utf-8")).toContain("routing-only trigger");
    expect(readFileSync(mergedSkillPath!, "utf-8")).not.toContain("body-only trigger");
    expect(readFileSync(bodyVariantPath, "utf-8")).toContain("body-only trigger");
    expect(readFileSync(bodyVariantPath, "utf-8")).not.toContain("routing-only trigger");
  });
});
