import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../packages/runtime/localdb/db.js";
import { summarizeReplayRuntimeMetrics } from "../packages/runtime/create/replay.js";

import type { CreatePackageEvaluationResult } from "../packages/runtime/create/package-evaluator.js";
import {
  applySearchRunWinner,
  computeBodyWeakness,
  generateSearchRunVariants,
  planVariantCounts,
} from "@selftune/orchestration/search-run";

let tempRoot = "";
const databases: ReturnType<typeof openDb>[] = [];

function createDatabase() {
  const db = openDb(":memory:");
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

function makeEvaluation(skillPath: string): CreatePackageEvaluationResult {
  return {
    summary: {
      skill_name: "code-review",
      skill_path: skillPath,
      mode: "package",
      evaluation_source: "fresh",
      status: "passed",
      evaluation_passed: true,
      next_command: null,
      package_fingerprint: "pkg_sha256_abc123",
      replay: {
        mode: "package",
        validation_mode: "host_replay",
        agent: "claude",
        proposal_id: "proposal-1",
        fixture_id: "fixture-1",
        total: 2,
        passed: 2,
        failed: 0,
        pass_rate: 1,
      },
      baseline: {
        mode: "package",
        baseline_pass_rate: 0.4,
        with_skill_pass_rate: 0.9,
        lift: 0.5,
        adds_value: true,
        measured_at: "2026-04-15T00:00:00.000Z",
      },
    },
    replay: {
      skill: "code-review",
      skill_path: skillPath,
      mode: "package",
      agent: "claude",
      proposal_id: "proposal-1",
      total: 2,
      passed: 2,
      failed: 0,
      pass_rate: 1,
      fixture_id: "fixture-1",
      results: [],
      runtime_metrics: summarizeReplayRuntimeMetrics([]),
    },
    baseline: {
      skill_name: "code-review",
      mode: "package",
      baseline_pass_rate: 0.4,
      with_skill_pass_rate: 0.9,
      lift: 0.5,
      adds_value: true,
      per_entry: [],
      measured_at: "2026-04-15T00:00:00.000Z",
    },
  };
}

describe("selftune search-run", () => {
  test("planVariantCounts biases the minibatch toward the weaker measured surface", () => {
    const plan = planVariantCounts("both", 5, {
      weakness_source: "accepted_frontier",
      routing_weakness: 0.9,
      body_weakness: 0.1,
    });

    expect(plan.routing_count).toBe(4);
    expect(plan.body_count).toBe(1);
    expect(plan.weakness_source).toBe("accepted_frontier");
  });

  test("computeBodyWeakness treats null quality on a valid body as neutral", () => {
    const weakness = computeBodyWeakness({
      ...makeEvaluation("/tmp/code-review/SKILL.md").summary,
      body: {
        structural_valid: true,
        structural_reason: "ok",
        quality_score: null,
        quality_reason: null,
        quality_threshold: 0.7,
        quality_passed: null,
        valid: true,
      },
    });

    expect(weakness).toBe(0.5);
  });

  test("applySearchRunWinner promotes the winning skill file and refreshes canonical artifacts", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "selftune-search-run-"));
    const winnerSkillPath = join(tempRoot, "winner", "SKILL.md");
    const targetSkillPath = join(tempRoot, "target", "SKILL.md");
    mkdirSync(join(tempRoot, "winner"), { recursive: true });
    mkdirSync(join(tempRoot, "target"), { recursive: true });
    writeFileSync(winnerSkillPath, "# Winner Skill\n\nImproved winner content.\n", "utf-8");
    writeFileSync(targetSkillPath, "# Target Skill\n\nOld content.\n", "utf-8");

    const evaluation = makeEvaluation(winnerSkillPath);
    const writtenSummaries: CreatePackageEvaluationResult["summary"][] = [];
    const writtenArtifacts: CreatePackageEvaluationResult[] = [];

    const result = applySearchRunWinner("code-review", targetSkillPath, "pkgcand_code-review_abc", {
      readPackageCandidateArtifact: () => evaluation,
      writeCanonicalPackageEvaluation: (_skillName, summary) => {
        writtenSummaries.push(summary);
        return join(tempRoot, "summary.json");
      },
      writeCanonicalPackageEvaluationArtifact: (_skillName, artifact) => {
        writtenArtifacts.push(artifact);
        return join(tempRoot, "artifact.json");
      },
    });

    expect(readFileSync(targetSkillPath, "utf-8")).toContain("Improved winner content.");
    expect(result.applied_winner).toBe(true);
    expect(result.applied_candidate_id).toBe("pkgcand_code-review_abc");
    expect(result.next_command).toBe(`selftune publish --skill-path ${targetSkillPath}`);
    expect(result.package_evaluation?.skill_path).toBe(targetSkillPath);
    expect(result.package_evaluation?.evaluation_source).toBe("candidate_cache");
    expect(writtenSummaries.at(-1)?.skill_path).toBe(targetSkillPath);
    expect(writtenSummaries.at(-1)?.next_command).toBe(
      `selftune publish --skill-path ${targetSkillPath}`,
    );
    expect(writtenArtifacts.at(-1)?.summary.skill_path).toBe(targetSkillPath);
    expect(writtenArtifacts.at(-1)?.replay.skill_path).toBe(targetSkillPath);
  });

  test("generateSearchRunVariants prefers reflective variants, then targeted, then fallback", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "selftune-search-run-targeted-"));
    const skillPath = join(tempRoot, "skill", "SKILL.md");
    mkdirSync(join(tempRoot, "skill"), { recursive: true });
    writeFileSync(skillPath, "# Skill\n", "utf-8");

    const reflectiveRoutingPath = join(tempRoot, "routing-reflective", "SKILL.md");
    const targetedRoutingPath = join(tempRoot, "routing-targeted", "SKILL.md");
    const fallbackRoutingPath = join(tempRoot, "routing-fallback", "SKILL.md");
    const reflectiveBodyPath = join(tempRoot, "body-reflective", "SKILL.md");
    const targetedBodyPath = join(tempRoot, "body-targeted", "SKILL.md");
    let fallbackBodyCalls = 0;

    const generated = await generateSearchRunVariants(
      skillPath,
      "code-review",
      {
        routing_count: 2,
        body_count: 1,
        weakness_source: "accepted_frontier",
        routing_weakness: 0.8,
        body_weakness: 0.4,
      },
      "claude",
      createDatabase(),
      {
        extractMutationWeaknesses: () => ({
          replayFailureSamples: ["missed routing query"],
          routingFailureSamples: [],
          bodyQualityScore: 0.4,
          gradingPassRateDelta: -0.2,
          gradingFailurePatterns: ["missing explanation"],
        }),
        generateReflectiveRoutingMutations: async () => [
          {
            variantSkillPath: reflectiveRoutingPath,
            mutationSurface: "routing",
            mutationDescription: "Reflective routing",
            parentFingerprint: "parent",
          },
        ],
        generateTargetedRoutingMutations: () => [
          {
            variantSkillPath: targetedRoutingPath,
            mutationSurface: "routing",
            mutationDescription: "Targeted routing",
            parentFingerprint: "parent",
          },
        ],
        generateRoutingMutations: async () => [
          {
            variantSkillPath: fallbackRoutingPath,
            mutationSurface: "routing",
            mutationDescription: "Deterministic routing",
            parentFingerprint: "parent",
          },
        ],
        generateReflectiveBodyMutations: async () => [
          {
            variantSkillPath: reflectiveBodyPath,
            mutationSurface: "body",
            mutationDescription: "Reflective body",
            parentFingerprint: "parent",
          },
        ],
        generateTargetedBodyMutations: () => [
          {
            variantSkillPath: targetedBodyPath,
            mutationSurface: "body",
            mutationDescription: "Targeted body",
            parentFingerprint: "parent",
          },
        ],
        generateBodyMutations: async () => {
          fallbackBodyCalls += 1;
          return [
            {
              variantSkillPath: join(tempRoot, "body-fallback", "SKILL.md"),
              mutationSurface: "body",
              mutationDescription: "Deterministic body",
              parentFingerprint: "parent",
            },
          ];
        },
        computeCreatePackageFingerprint: (path) =>
          ({
            [reflectiveRoutingPath]: "routing-reflective",
            [targetedRoutingPath]: "routing-targeted",
            [fallbackRoutingPath]: "routing-fallback",
            [reflectiveBodyPath]: "body-reflective",
            [targetedBodyPath]: "body-targeted",
          })[path] ?? null,
      },
    );

    expect(generated.generated_variants).toEqual([
      {
        skill_path: reflectiveRoutingPath,
        mutation_surface: "routing",
        mutation_description: "Reflective routing",
        fingerprint: "routing-reflective",
      },
      {
        skill_path: targetedRoutingPath,
        mutation_surface: "routing",
        mutation_description: "Targeted routing",
        fingerprint: "routing-targeted",
      },
      {
        skill_path: reflectiveBodyPath,
        mutation_surface: "body",
        mutation_description: "Reflective body",
        fingerprint: "body-reflective",
      },
    ]);
    expect(fallbackBodyCalls).toBe(0);
  });

  test("generateSearchRunVariants falls back when reflective generation fails", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "selftune-search-run-reflective-fallback-"));
    const skillPath = join(tempRoot, "skill", "SKILL.md");
    mkdirSync(join(tempRoot, "skill"), { recursive: true });
    writeFileSync(skillPath, "# Skill\n", "utf-8");

    const targetedRoutingPath = join(tempRoot, "routing-targeted", "SKILL.md");
    const fallbackBodyPath = join(tempRoot, "body-fallback", "SKILL.md");

    const generated = await generateSearchRunVariants(
      skillPath,
      "PkgSkill",
      {
        routing_count: 1,
        body_count: 1,
        weakness_source: "accepted_frontier",
        routing_weakness: 0.8,
        body_weakness: 0.7,
      },
      "claude",
      createDatabase(),
      {
        extractMutationWeaknesses: () => ({
          replayFailureSamples: ["fix broken routing"],
          routingFailureSamples: [],
          bodyQualityScore: 0.4,
          gradingPassRateDelta: -0.1,
          gradingFailurePatterns: ["missing verification"],
        }),
        generateReflectiveRoutingMutations: async () => {
          throw new Error("llm offline");
        },
        generateReflectiveBodyMutations: async () => {
          throw new Error("llm offline");
        },
        generateTargetedRoutingMutations: () => [
          {
            variantSkillPath: targetedRoutingPath,
            mutationSurface: "routing",
            mutationDescription: "Targeted routing",
            parentFingerprint: "parent",
          },
        ],
        generateTargetedBodyMutations: () => [],
        generateRoutingMutations: async () => [],
        generateBodyMutations: async () => [
          {
            variantSkillPath: fallbackBodyPath,
            mutationSurface: "body",
            mutationDescription: "Deterministic body",
            parentFingerprint: "parent",
          },
        ],
        computeCreatePackageFingerprint: (path) =>
          ({
            [targetedRoutingPath]: "routing-targeted",
            [fallbackBodyPath]: "body-fallback",
          })[path] ?? null,
      },
    );

    expect(generated.generated_variants).toEqual([
      {
        skill_path: targetedRoutingPath,
        mutation_surface: "routing",
        mutation_description: "Targeted routing",
        fingerprint: "routing-targeted",
      },
      {
        skill_path: fallbackBodyPath,
        mutation_surface: "body",
        mutation_description: "Deterministic body",
        fingerprint: "body-fallback",
      },
    ]);
  });
});
