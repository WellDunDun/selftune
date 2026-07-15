import { describe, expect, test } from "bun:test";

import {
  selectCandidates,
  shouldSelectPackageSearch,
} from "@selftune/orchestration/orchestrate/plan";
import { runPackageSearchPhase } from "@selftune/orchestration/orchestrate/execute";
import type { CandidateContext, SkillAction } from "@selftune/orchestration/orchestrate";
import type { SkillStatus } from "../../packages/runtime/status.js";
import type { MonitoringSnapshot } from "../../packages/runtime/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<MonitoringSnapshot> = {}): MonitoringSnapshot {
  return {
    timestamp: new Date().toISOString(),
    skill_name: "TestSkill",
    window_sessions: 20,
    skill_checks: 10,
    pass_rate: 0.8,
    false_negative_rate: 0.1,
    by_invocation_type: {
      explicit: { passed: 5, total: 5 },
      implicit: { passed: 3, total: 5 },
      contextual: { passed: 0, total: 0 },
      negative: { passed: 0, total: 0 },
    },
    regression_detected: false,
    baseline_pass_rate: 0.5,
    ...overrides,
  };
}

function makeSkill(overrides: Partial<SkillStatus> = {}): SkillStatus {
  return {
    name: "TestSkill",
    passRate: 0.8,
    trend: "stable",
    missedQueries: 0,
    status: "HEALTHY",
    snapshot: makeSnapshot(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// shouldSelectPackageSearch
// ---------------------------------------------------------------------------

describe("shouldSelectPackageSearch", () => {
  test("returns true when skill is in packageFrontierSkills", () => {
    const skill = makeSkill({ name: "MySkill", status: "WARNING", missedQueries: 3 });
    const context: CandidateContext = {
      maxSkills: 5,
      packageFrontierSkills: new Set(["MySkill"]),
    };
    expect(shouldSelectPackageSearch(skill, context)).toBe(true);
  });

  test("returns false when packageFrontierSkills is undefined", () => {
    const skill = makeSkill({ name: "MySkill", status: "WARNING", missedQueries: 3 });
    const context: CandidateContext = {
      maxSkills: 5,
    };
    expect(shouldSelectPackageSearch(skill, context)).toBe(false);
  });

  test("returns false when skill is not in packageFrontierSkills", () => {
    const skill = makeSkill({ name: "MySkill", status: "WARNING", missedQueries: 3 });
    const context: CandidateContext = {
      maxSkills: 5,
      packageFrontierSkills: new Set(["OtherSkill"]),
    };
    expect(shouldSelectPackageSearch(skill, context)).toBe(false);
  });

  test("returns false when packageFrontierSkills is empty", () => {
    const skill = makeSkill({ name: "MySkill", status: "WARNING", missedQueries: 3 });
    const context: CandidateContext = {
      maxSkills: 5,
      packageFrontierSkills: new Set(),
    };
    expect(shouldSelectPackageSearch(skill, context)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// selectCandidates with package-search routing
// ---------------------------------------------------------------------------

describe("selectCandidates with package-search", () => {
  test("tags candidate as package-search when in frontier", () => {
    const skills = [
      makeSkill({ name: "FrontierSkill", status: "CRITICAL", passRate: 0.2, missedQueries: 5 }),
    ];
    const result = selectCandidates(skills, {
      maxSkills: 5,
      packageFrontierSkills: new Set(["FrontierSkill"]),
    });
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe("package-search");
    expect(result[0].reason).toContain("CRITICAL");
  });

  test("tags candidate as evolve when not in frontier", () => {
    const skills = [
      makeSkill({ name: "RegularSkill", status: "CRITICAL", passRate: 0.2, missedQueries: 5 }),
    ];
    const result = selectCandidates(skills, {
      maxSkills: 5,
      packageFrontierSkills: new Set(["OtherSkill"]),
    });
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe("evolve");
  });

  test("package-search and evolve both count toward maxSkills cap", () => {
    const skills = [
      makeSkill({ name: "PkgSkill", status: "CRITICAL", passRate: 0.1, missedQueries: 10 }),
      makeSkill({ name: "EvolveSkill", status: "CRITICAL", passRate: 0.2, missedQueries: 8 }),
      makeSkill({ name: "CappedSkill", status: "CRITICAL", passRate: 0.3, missedQueries: 6 }),
    ];
    const result = selectCandidates(skills, {
      maxSkills: 2,
      packageFrontierSkills: new Set(["PkgSkill"]),
    });
    const active = result.filter((r) => r.action !== "skip");
    expect(active.length).toBe(2);
    const capped = result.find((r) => r.reason.includes("capped"));
    expect(capped).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// runPackageSearchPhase
// ---------------------------------------------------------------------------

describe("runPackageSearchPhase", () => {
  test("returns empty when no candidates", async () => {
    const result = await runPackageSearchPhase({
      packageSearchCandidates: [],
      dryRun: false,
      agent: "claude",
      resolveSkillPath: () => "/fake/path/SKILL.md",
    });
    expect(result).toEqual([]);
  });

  test("skips candidates when skill path not found", async () => {
    const candidate: SkillAction = {
      skill: "MissingSkill",
      action: "package-search",
      reason: "test",
    };
    const result = await runPackageSearchPhase({
      packageSearchCandidates: [candidate],
      dryRun: false,
      agent: "claude",
      resolveSkillPath: () => undefined,
    });
    expect(result).toEqual([]);
    expect(candidate.action).toBe("skip");
    expect(candidate.reason).toContain("SKILL.md not found");
  });

  test("marks candidates as dry-run without searching", async () => {
    const candidate: SkillAction = {
      skill: "DryRunSkill",
      action: "package-search",
      reason: "test",
    };
    const result = await runPackageSearchPhase({
      packageSearchCandidates: [candidate],
      dryRun: true,
      agent: "claude",
      resolveSkillPath: () => "/fake/path/SKILL.md",
    });
    expect(result).toEqual([]);
    expect(candidate.packageSearchResult).toBeDefined();
    expect(candidate.packageSearchResult!.searched).toBe(false);
    expect(candidate.packageSearchResult!.winnerApplied).toBe(false);
  });

  test("gracefully handles missing package-search modules", async () => {
    // Since the package-search modules don't exist yet in this worktree,
    // the dynamic imports will fail and candidates should be skipped.
    const candidate: SkillAction = {
      skill: "TestSkill",
      action: "package-search",
      reason: "test",
    };
    const result = await runPackageSearchPhase({
      packageSearchCandidates: [candidate],
      dryRun: false,
      agent: "claude",
      resolveSkillPath: () => "/fake/path/SKILL.md",
    });
    // Invalid skill path → candidates skipped with error
    expect(result).toEqual([]);
    expect(candidate.action).toBe("skip");
    expect(candidate.reason).toContain("package-search error");
  });

  test("applies the winning candidate using current search and winner contracts", async () => {
    const candidate: SkillAction = {
      skill: "PkgSkill",
      action: "package-search",
      reason: "test",
    };
    const db = {} as never;
    const variantSkillPath = "/tmp/PkgSkill-variant/SKILL.md";
    const result = await runPackageSearchPhase({
      packageSearchCandidates: [candidate],
      dryRun: false,
      agent: "claude",
      resolveSkillPath: () => "/tmp/PkgSkill/SKILL.md",
      deps: {
        generateReflectiveRoutingMutations: async () => [],
        generateReflectiveBodyMutations: async () => [],
        generateRoutingMutations: async () => [
          {
            variantSkillPath,
            mutationSurface: "routing",
            mutationDescription: "deterministic routing mutation",
            parentFingerprint: "parent-fp",
          },
        ],
        generateBodyMutations: async () => [],
        generateTargetedRoutingMutations: () => [],
        generateTargetedBodyMutations: () => [],
        extractMutationWeaknesses: () => ({
          replayFailureSamples: [],
          routingFailureSamples: [],
          bodyQualityScore: 1,
          gradingPassRateDelta: 0,
        }),
        cleanupVariants: () => {},
        computeCreatePackageFingerprint: (skillPath) =>
          skillPath === variantSkillPath ? "pkg_sha256_variant" : null,
        runPackageSearch: async (options) => {
          expect(options.candidate_paths).toEqual([
            {
              skill_path: variantSkillPath,
              fingerprint: "pkg_sha256_variant",
            },
          ]);
          return {
            search_id: "search-1",
            skill_name: "PkgSkill",
            parent_candidate_id: "pkgcand_parent",
            candidates_evaluated: 1,
            winner_candidate_id: "pkgcand_winner",
            winner_rationale: "Accepted winner",
            started_at: "2026-04-15T00:00:00.000Z",
            completed_at: "2026-04-15T00:00:01.000Z",
            provenance: {
              frontier_size: 1,
              parent_selection_method: "highest_ranked_frontier",
              candidate_fingerprints: ["pkg_sha256_variant"],
              evaluation_summaries: [],
            },
          };
        },
        applySearchRunWinner: () => ({
          applied_winner: true,
          applied_candidate_id: "pkgcand_winner",
          next_command: "selftune publish --skill-path /tmp/PkgSkill/SKILL.md",
          package_evaluation: null,
        }),
        getDb: () => db,
      },
    });

    expect(result).toEqual([candidate]);
    expect(candidate.packageSearchResult).toEqual({
      searched: true,
      winnerApplied: true,
      candidateCount: 1,
      winnerCandidateId: "pkgcand_winner",
    });
  });

  test("prioritizes reflective mutations before targeted and deterministic variants", async () => {
    const candidate: SkillAction = {
      skill: "PkgSkill",
      action: "package-search",
      reason: "test",
    };
    const candidatePathsSeen: Array<{ skill_path: string; fingerprint: string }> = [];

    await runPackageSearchPhase({
      packageSearchCandidates: [candidate],
      dryRun: false,
      agent: "claude",
      resolveSkillPath: () => "/tmp/PkgSkill/SKILL.md",
      deps: {
        generateReflectiveRoutingMutations: async () => [
          {
            variantSkillPath: "/tmp/PkgSkill-reflective-routing/SKILL.md",
            mutationSurface: "routing",
            mutationDescription: "reflective routing mutation",
            parentFingerprint: "parent-fp",
          },
        ],
        generateReflectiveBodyMutations: async () => [],
        generateRoutingMutations: async () => [
          {
            variantSkillPath: "/tmp/PkgSkill-deterministic-routing/SKILL.md",
            mutationSurface: "routing",
            mutationDescription: "deterministic routing mutation",
            parentFingerprint: "parent-fp",
          },
        ],
        generateBodyMutations: async () => [],
        generateTargetedRoutingMutations: () => [
          {
            variantSkillPath: "/tmp/PkgSkill-targeted-routing/SKILL.md",
            mutationSurface: "routing",
            mutationDescription: "targeted routing mutation",
            parentFingerprint: "parent-fp",
          },
        ],
        generateTargetedBodyMutations: () => [
          {
            variantSkillPath: "/tmp/PkgSkill-targeted-body/SKILL.md",
            mutationSurface: "body",
            mutationDescription: "targeted body mutation",
            parentFingerprint: "parent-fp",
          },
        ],
        extractMutationWeaknesses: () => ({
          replayFailureSamples: ["missed routing query"],
          routingFailureSamples: [],
          bodyQualityScore: 0.4,
          gradingPassRateDelta: -0.2,
        }),
        cleanupVariants: () => {},
        computeCreatePackageFingerprint: (skillPath) => `fp:${skillPath}`,
        runPackageSearch: async (options) => {
          candidatePathsSeen.push(...options.candidate_paths);
          return {
            search_id: "search-2",
            skill_name: "PkgSkill",
            parent_candidate_id: null,
            candidates_evaluated: options.candidate_paths.length,
            winner_candidate_id: null,
            winner_rationale: null,
            started_at: "2026-04-15T00:00:00.000Z",
            completed_at: "2026-04-15T00:00:01.000Z",
            provenance: {
              frontier_size: 0,
              parent_selection_method: "none_first_run",
              candidate_fingerprints: options.candidate_paths.map((path) => path.fingerprint),
              evaluation_summaries: [],
            },
          };
        },
        applySearchRunWinner: () => ({
          applied_winner: false,
          applied_candidate_id: null,
          next_command: null,
          package_evaluation: null,
        }),
        getDb: () => ({}) as never,
      },
    });

    expect(candidatePathsSeen.map((path) => path.skill_path)).toEqual([
      "/tmp/PkgSkill-reflective-routing/SKILL.md",
      "/tmp/PkgSkill-targeted-routing/SKILL.md",
      "/tmp/PkgSkill-targeted-body/SKILL.md",
      "/tmp/PkgSkill-deterministic-routing/SKILL.md",
    ]);
  });
});
