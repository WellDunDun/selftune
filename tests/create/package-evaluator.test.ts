import { describe, expect, it } from "bun:test";

import {
  formatCreatePackageBenchmarkReport,
  runCreatePackageEvaluation,
} from "../../packages/runtime/create/package-evaluator.js";

function attachCandidateState<T extends { summary: Record<string, unknown> }>(evaluation: T): T {
  const skillName =
    typeof evaluation.summary["skill_name"] === "string"
      ? (evaluation.summary["skill_name"] as string)
      : "skill";
  const packageFingerprint =
    typeof evaluation.summary["package_fingerprint"] === "string"
      ? (evaluation.summary["package_fingerprint"] as string)
      : "pkg_sha256_candidate";
  const fingerprintSuffix = packageFingerprint.replace(/^pkg_sha256_/, "").slice(0, 16);
  return {
    ...evaluation,
    summary: {
      ...evaluation.summary,
      candidate_id: `pkgcand_${skillName}_${fingerprintSuffix}`,
      parent_candidate_id: null,
      candidate_generation: 0,
      candidate_acceptance: {
        decision: "root",
        compared_to_candidate_id: null,
        decided_at: "2026-04-15T09:00:00.000Z",
        rationale: "Initial measured package candidate for this skill.",
        replay_pass_rate_delta: null,
        routing_pass_rate_delta: null,
        baseline_lift_delta: null,
        body_quality_delta: null,
        unit_test_pass_rate_delta: null,
      },
    },
  };
}

describe("selftune create package evaluator", () => {
  it("reuses the measured with-skill replay when computing the package baseline", async () => {
    let replayCalls = 0;
    let baselineWithSkillReplayReuse = false;
    let storedSummary: unknown = null;
    let storedArtifact: unknown = null;

    const result = await runCreatePackageEvaluation(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
      },
      {
        computeCreatePackageFingerprint: () => "pkg_sha256_eval123456",
        readSkillContent: () =>
          `---
name: research-assistant
description: >
  Use when the user needs evidence-backed research help.
---

# Research Assistant

Current draft package.

## Workflow Routing

| Trigger | Workflow |
| --- | --- |
| Research this company | default |
`,
        assessBodyQuality: async () => ({
          score: 0.82,
          reason: "The current body is clear and preserves the routing table.",
        }),
        writeCanonicalPackageEvaluation: (_skillName, summary) => {
          storedSummary = summary;
          return "/tmp/.selftune/package-evaluations/research-assistant.json";
        },
        writeCanonicalPackageEvaluationArtifact: (_skillName, artifact) => {
          storedArtifact = artifact;
          return "/tmp/.selftune/package-evaluations/research-assistant.artifact.json";
        },
        persistPackageCandidateEvaluation: attachCandidateState,
        runCreateReplay: async (options) => {
          replayCalls += 1;
          const isPackageMode = options.mode === "package";
          return {
            skill: "research-assistant",
            skill_path: "/tmp/research-assistant/SKILL.md",
            mode: options.mode,
            agent: "claude",
            proposal_id:
              options.includeTargetSkill === false
                ? "baseline"
                : isPackageMode
                  ? "with-skill"
                  : "routing",
            total: 2,
            passed: options.includeTargetSkill === false ? 1 : isPackageMode ? 2 : 1,
            failed: options.includeTargetSkill === false ? 1 : isPackageMode ? 0 : 1,
            pass_rate: options.includeTargetSkill === false ? 0.5 : isPackageMode ? 1 : 0.5,
            fixture_id: isPackageMode ? "fixture-1" : "fixture-routing",
            results: [
              {
                query: "research brief",
                should_trigger: true,
                triggered: options.includeTargetSkill !== false,
                passed: options.includeTargetSkill !== false && isPackageMode,
                evidence:
                  options.includeTargetSkill === false
                    ? "baseline skipped target skill"
                    : isPackageMode
                      ? "target skill selected in replay"
                      : "routing table missed the query",
                runtime_metrics: {
                  input_tokens: options.includeTargetSkill === false ? 20 : 50,
                  output_tokens: options.includeTargetSkill === false ? 5 : 15,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                  total_cost_usd: options.includeTargetSkill === false ? 0.003 : 0.008,
                  duration_ms: options.includeTargetSkill === false ? 300 : 700,
                  num_turns: 1,
                },
              },
              {
                query: "write docs",
                should_trigger: false,
                triggered: false,
                passed: true,
                evidence: "negative control held",
                runtime_metrics: {
                  input_tokens: options.includeTargetSkill === false ? 10 : 30,
                  output_tokens: options.includeTargetSkill === false ? 5 : 10,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                  total_cost_usd: options.includeTargetSkill === false ? 0.002 : 0.006,
                  duration_ms: options.includeTargetSkill === false ? 200 : 500,
                  num_turns: 1,
                },
              },
            ],
            runtime_metrics: {
              eval_runs: 2,
              usage_observations: 2,
              total_duration_ms:
                options.includeTargetSkill === false ? 500 : isPackageMode ? 1200 : 900,
              avg_duration_ms:
                options.includeTargetSkill === false ? 250 : isPackageMode ? 600 : 450,
              total_input_tokens:
                options.includeTargetSkill === false ? 30 : isPackageMode ? 80 : 65,
              total_output_tokens:
                options.includeTargetSkill === false ? 10 : isPackageMode ? 25 : 20,
              total_cache_creation_input_tokens: 0,
              total_cache_read_input_tokens: 0,
              total_cost_usd:
                options.includeTargetSkill === false ? 0.005 : isPackageMode ? 0.014 : 0.01,
              total_turns: 2,
            },
          };
        },
        runCreateBaseline: async (options) => {
          baselineWithSkillReplayReuse =
            options.withSkillReplayResult?.proposal_id === "with-skill";
          return {
            skill_name: "research-assistant",
            mode: "package",
            baseline_pass_rate: 0.5,
            with_skill_pass_rate: 1,
            lift: 0.5,
            adds_value: true,
            per_entry: [
              {
                skill_name: "research-assistant",
                query: "research brief",
                with_skill: false,
                triggered: false,
                pass: false,
                evidence: "baseline skipped target skill",
                measured_at: "2026-04-14T12:00:00.000Z",
              },
              {
                skill_name: "research-assistant",
                query: "research brief",
                with_skill: true,
                triggered: true,
                pass: true,
                evidence: "target skill selected in replay",
                measured_at: "2026-04-14T12:00:00.000Z",
              },
            ],
            measured_at: "2026-04-14T12:00:00.000Z",
            runtime_metrics: {
              with_skill: {
                eval_runs: 2,
                usage_observations: 2,
                total_duration_ms: 1200,
                avg_duration_ms: 600,
                total_input_tokens: 80,
                total_output_tokens: 25,
                total_cache_creation_input_tokens: 0,
                total_cache_read_input_tokens: 0,
                total_cost_usd: 0.014,
                total_turns: 2,
              },
              without_skill: {
                eval_runs: 2,
                usage_observations: 2,
                total_duration_ms: 500,
                avg_duration_ms: 250,
                total_input_tokens: 30,
                total_output_tokens: 10,
                total_cache_creation_input_tokens: 0,
                total_cache_read_input_tokens: 0,
                total_cost_usd: 0.005,
                total_turns: 2,
              },
            },
          };
        },
      },
    );

    expect(replayCalls).toBe(2);
    expect(baselineWithSkillReplayReuse).toBe(true);
    expect(result.summary.evaluation_passed).toBe(true);
    expect(result.summary.evaluation_source).toBe("fresh");
    expect(result.summary.status).toBe("passed");
    expect(result.summary.package_fingerprint).toBe("pkg_sha256_eval123456");
    expect(result.summary.candidate_id).toBe("pkgcand_research-assistant_eval123456");
    expect(result.summary.candidate_generation).toBe(0);
    expect(result.summary.replay.proposal_id).toBe("with-skill");
    expect(result.summary.routing?.proposal_id).toBe("routing");
    expect(result.summary.routing?.pass_rate).toBe(0.5);
    expect(result.summary.body).toEqual({
      structural_valid: true,
      structural_reason: "Structural validation passed",
      quality_score: 0.82,
      quality_reason: "The current body is clear and preserves the routing table.",
      quality_threshold: 0.6,
      quality_passed: true,
      valid: true,
    });
    expect(result.summary.replay.runtime_metrics?.total_input_tokens).toBe(80);
    expect(result.summary.baseline.lift).toBe(0.5);
    expect(result.summary.evidence).toEqual({
      replay_failures: 0,
      baseline_wins: 1,
      baseline_regressions: 0,
      replay_failure_samples: [],
      baseline_win_samples: [
        {
          query: "research brief",
          evidence: "target skill selected in replay",
        },
      ],
      baseline_regression_samples: [],
    });
    expect(result.summary.efficiency?.with_skill.total_duration_ms).toBe(1200);
    expect(result.summary.efficiency?.without_skill.total_input_tokens).toBe(30);
    expect(storedSummary).toEqual(result.summary);
    expect(storedArtifact).toEqual(result);
  });

  it("reuses a stored package evaluation artifact when the fingerprint still matches", async () => {
    let replayCalls = 0;
    let baselineCalls = 0;

    const cachedResult = {
      summary: {
        skill_name: "research-assistant",
        skill_path: "/tmp/research-assistant/SKILL.md",
        mode: "package" as const,
        package_fingerprint: "pkg_sha256_eval123456",
        candidate_id: "pkgcand_research-assistant_eval123456",
        parent_candidate_id: null,
        candidate_generation: 0,
        candidate_acceptance: {
          decision: "root" as const,
          compared_to_candidate_id: null,
          decided_at: "2026-04-15T09:00:00.000Z",
          rationale: "Initial measured package candidate for this skill.",
          replay_pass_rate_delta: null,
          routing_pass_rate_delta: null,
          baseline_lift_delta: null,
          body_quality_delta: null,
          unit_test_pass_rate_delta: null,
        },
        status: "passed" as const,
        evaluation_passed: true,
        next_command: null,
        replay: {
          mode: "package" as const,
          validation_mode: "host_replay" as const,
          agent: "claude",
          proposal_id: "cached-with-skill",
          fixture_id: "fixture-1",
          total: 2,
          passed: 2,
          failed: 0,
          pass_rate: 1,
        },
        routing: {
          mode: "routing" as const,
          validation_mode: "host_replay" as const,
          agent: "claude",
          proposal_id: "cached-routing",
          fixture_id: "fixture-routing",
          total: 2,
          passed: 2,
          failed: 0,
          pass_rate: 1,
        },
        baseline: {
          mode: "package" as const,
          baseline_pass_rate: 0.5,
          with_skill_pass_rate: 1,
          lift: 0.5,
          adds_value: true,
          measured_at: "2026-04-14T12:00:00.000Z",
        },
        body: {
          structural_valid: true,
          structural_reason: "Structural validation passed",
          quality_score: 0.82,
          quality_reason: "The cached body remains valid.",
          quality_threshold: 0.6,
          quality_passed: true,
          valid: true,
        },
      },
      replay: {
        skill: "research-assistant",
        skill_path: "/tmp/research-assistant/SKILL.md",
        mode: "package" as const,
        agent: "claude",
        proposal_id: "cached-with-skill",
        total: 2,
        passed: 2,
        failed: 0,
        pass_rate: 1,
        fixture_id: "fixture-1",
        results: [],
      },
      baseline: {
        skill_name: "research-assistant",
        mode: "package" as const,
        baseline_pass_rate: 0.5,
        with_skill_pass_rate: 1,
        lift: 0.5,
        adds_value: true,
        per_entry: [],
        measured_at: "2026-04-14T12:00:00.000Z",
      },
    };

    const result = await runCreatePackageEvaluation(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
      },
      {
        computeCreatePackageFingerprint: () => "pkg_sha256_eval123456",
        readCanonicalPackageEvaluationArtifact: () => cachedResult,
        runCreateReplay: async () => {
          replayCalls += 1;
          throw new Error("replay should not run when the package artifact is fresh");
        },
        runCreateBaseline: async () => {
          baselineCalls += 1;
          throw new Error("baseline should not run when the package artifact is fresh");
        },
      },
    );

    expect(result).toEqual({
      ...cachedResult,
      summary: {
        ...cachedResult.summary,
        evaluation_source: "artifact_cache",
      },
    });
    expect(replayCalls).toBe(0);
    expect(baselineCalls).toBe(0);
  });

  it("reuses an accepted candidate artifact when the latest canonical artifact points at another draft", async () => {
    let replayCalls = 0;
    let baselineCalls = 0;
    let candidateLookup: unknown = null;

    const candidateCachedResult = {
      summary: {
        skill_name: "research-assistant",
        skill_path: "/tmp/research-assistant/SKILL.md",
        mode: "package" as const,
        package_fingerprint: "pkg_sha256_eval123456",
        candidate_id: "pkgcand_research-assistant_eval123456",
        parent_candidate_id: "pkgcand_research-assistant_root0001",
        candidate_generation: 2,
        candidate_acceptance: {
          decision: "accepted" as const,
          compared_to_candidate_id: "pkgcand_research-assistant_root0001",
          decided_at: "2026-04-15T09:00:00.000Z",
          rationale: "Measured improvement vs parent: replay +20.0%, baseline lift +0.250.",
          replay_pass_rate_delta: 0.2,
          routing_pass_rate_delta: null,
          baseline_lift_delta: 0.25,
          body_quality_delta: null,
          unit_test_pass_rate_delta: null,
        },
        status: "passed" as const,
        evaluation_passed: true,
        next_command: null,
        replay: {
          mode: "package" as const,
          validation_mode: "host_replay" as const,
          agent: "claude",
          proposal_id: "candidate-with-skill",
          fixture_id: "fixture-1",
          total: 2,
          passed: 2,
          failed: 0,
          pass_rate: 1,
        },
        routing: {
          mode: "routing" as const,
          validation_mode: "host_replay" as const,
          agent: "claude",
          proposal_id: "candidate-routing",
          fixture_id: "fixture-routing",
          total: 2,
          passed: 2,
          failed: 0,
          pass_rate: 1,
        },
        baseline: {
          mode: "package" as const,
          baseline_pass_rate: 0.5,
          with_skill_pass_rate: 1,
          lift: 0.5,
          adds_value: true,
          measured_at: "2026-04-14T12:00:00.000Z",
        },
        body: {
          structural_valid: true,
          structural_reason: "Structural validation passed",
          quality_score: 0.82,
          quality_reason: "The cached frontier body remains valid.",
          quality_threshold: 0.6,
          quality_passed: true,
          valid: true,
        },
      },
      replay: {
        skill: "research-assistant",
        skill_path: "/tmp/research-assistant/SKILL.md",
        mode: "package" as const,
        agent: "claude",
        proposal_id: "candidate-with-skill",
        total: 2,
        passed: 2,
        failed: 0,
        pass_rate: 1,
        fixture_id: "fixture-1",
        results: [],
      },
      baseline: {
        skill_name: "research-assistant",
        mode: "package" as const,
        baseline_pass_rate: 0.5,
        with_skill_pass_rate: 1,
        lift: 0.5,
        adds_value: true,
        per_entry: [],
        measured_at: "2026-04-14T12:00:00.000Z",
      },
    };

    const result = await runCreatePackageEvaluation(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
      },
      {
        computeCreatePackageFingerprint: () => "pkg_sha256_eval123456",
        readCanonicalPackageEvaluationArtifact: () =>
          ({
            ...candidateCachedResult,
            summary: {
              ...candidateCachedResult.summary,
              package_fingerprint: "pkg_sha256_latestother123",
              candidate_id: "pkgcand_research-assistant_latestother123",
            },
          }) as never,
        readPackageCandidateArtifactByFingerprint: (_skillName, packageFingerprint, options) => {
          candidateLookup = {
            packageFingerprint,
            acceptedOnly: options?.acceptedOnly ?? null,
          };
          return candidateCachedResult;
        },
        runCreateReplay: async () => {
          replayCalls += 1;
          throw new Error("replay should not run when the accepted candidate artifact matches");
        },
        runCreateBaseline: async () => {
          baselineCalls += 1;
          throw new Error("baseline should not run when the accepted candidate artifact matches");
        },
      },
    );

    expect(candidateLookup).toEqual({
      packageFingerprint: "pkg_sha256_eval123456",
      acceptedOnly: true,
    });
    expect(result).toEqual({
      ...candidateCachedResult,
      summary: {
        ...candidateCachedResult.summary,
        evaluation_source: "candidate_cache",
      },
    });
    expect(replayCalls).toBe(0);
    expect(baselineCalls).toBe(0);
  });

  it("ignores a stored package evaluation artifact that predates candidate acceptance data", async () => {
    let replayCalls = 0;
    let baselineCalls = 0;

    const result = await runCreatePackageEvaluation(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
      },
      {
        computeCreatePackageFingerprint: () => "pkg_sha256_eval123456",
        readCanonicalPackageEvaluationArtifact: () =>
          ({
            summary: {
              skill_name: "research-assistant",
              skill_path: "/tmp/research-assistant/SKILL.md",
              mode: "package",
              package_fingerprint: "pkg_sha256_eval123456",
              candidate_id: "pkgcand_research-assistant_eval123456",
              parent_candidate_id: null,
              candidate_generation: 0,
              status: "passed",
              evaluation_passed: true,
              next_command: null,
              replay: {
                mode: "package",
                validation_mode: "host_replay",
                agent: "claude",
                proposal_id: "stale-with-skill",
                fixture_id: "fixture-1",
                total: 2,
                passed: 2,
                failed: 0,
                pass_rate: 1,
              },
              routing: {
                mode: "routing",
                validation_mode: "host_replay",
                agent: "claude",
                proposal_id: "stale-routing",
                fixture_id: "fixture-routing",
                total: 2,
                passed: 2,
                failed: 0,
                pass_rate: 1,
              },
              baseline: {
                mode: "package",
                baseline_pass_rate: 0.5,
                with_skill_pass_rate: 1,
                lift: 0.5,
                adds_value: true,
                measured_at: "2026-04-14T12:00:00.000Z",
              },
              body: {
                structural_valid: true,
                structural_reason: "Structural validation passed",
                quality_score: 0.82,
                quality_reason: "The cached body remains valid.",
                quality_threshold: 0.6,
                quality_passed: true,
                valid: true,
              },
            },
            replay: {
              skill: "research-assistant",
              skill_path: "/tmp/research-assistant/SKILL.md",
              mode: "package",
              agent: "claude",
              proposal_id: "stale-with-skill",
              total: 2,
              passed: 2,
              failed: 0,
              pass_rate: 1,
              fixture_id: "fixture-1",
              results: [],
            },
            baseline: {
              skill_name: "research-assistant",
              mode: "package",
              baseline_pass_rate: 0.5,
              with_skill_pass_rate: 1,
              lift: 0.5,
              adds_value: true,
              per_entry: [],
              measured_at: "2026-04-14T12:00:00.000Z",
            },
          }) as never,
        persistPackageCandidateEvaluation: attachCandidateState,
        runCreateReplay: async (options) => {
          replayCalls += 1;
          return {
            skill: "research-assistant",
            skill_path: "/tmp/research-assistant/SKILL.md",
            mode: options.mode,
            agent: "claude",
            proposal_id: options.mode === "package" ? "fresh-with-skill" : "fresh-routing",
            total: 2,
            passed: 2,
            failed: 0,
            pass_rate: 1,
            fixture_id: options.mode === "package" ? "fixture-1" : "fixture-routing",
            results: [],
          };
        },
        runCreateBaseline: async () => {
          baselineCalls += 1;
          return {
            skill_name: "research-assistant",
            mode: "package",
            baseline_pass_rate: 0.5,
            with_skill_pass_rate: 1,
            lift: 0.5,
            adds_value: true,
            per_entry: [],
            measured_at: "2026-04-14T12:00:00.000Z",
          };
        },
      },
    );

    expect(result.summary.evaluation_source).toBe("fresh");
    expect(result.summary.candidate_acceptance?.decision).toBe("root");
    expect(replayCalls).toBe(2);
    expect(baselineCalls).toBe(1);
  });

  it("ignores a stored package evaluation artifact when the fingerprint is stale", async () => {
    let replayCalls = 0;
    let baselineCalls = 0;

    const result = await runCreatePackageEvaluation(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
      },
      {
        computeCreatePackageFingerprint: () => "pkg_sha256_current1234",
        readCanonicalPackageEvaluationArtifact: () =>
          ({
            summary: {
              skill_name: "research-assistant",
              skill_path: "/tmp/research-assistant/SKILL.md",
              mode: "package",
              package_fingerprint: "pkg_sha256_stale12345678",
              candidate_id: "pkgcand_research-assistant_stale12345678",
              parent_candidate_id: null,
              candidate_generation: 0,
              status: "passed",
              evaluation_passed: true,
              next_command: null,
              replay: {
                mode: "package",
                validation_mode: "host_replay",
                agent: "claude",
                proposal_id: "stale-with-skill",
                fixture_id: "fixture-1",
                total: 2,
                passed: 2,
                failed: 0,
                pass_rate: 1,
              },
              routing: {
                mode: "routing",
                validation_mode: "host_replay",
                agent: "claude",
                proposal_id: "stale-routing",
                fixture_id: "fixture-routing",
                total: 2,
                passed: 2,
                failed: 0,
                pass_rate: 1,
              },
              baseline: {
                mode: "package",
                baseline_pass_rate: 0.5,
                with_skill_pass_rate: 1,
                lift: 0.5,
                adds_value: true,
                measured_at: "2026-04-14T12:00:00.000Z",
              },
              body: {
                structural_valid: true,
                structural_reason: "Structural validation passed",
                quality_score: 0.82,
                quality_reason: "The cached body remains valid.",
                quality_threshold: 0.6,
                quality_passed: true,
                valid: true,
              },
            },
            replay: {
              skill: "research-assistant",
              skill_path: "/tmp/research-assistant/SKILL.md",
              mode: "package",
              agent: "claude",
              proposal_id: "stale-with-skill",
              total: 2,
              passed: 2,
              failed: 0,
              pass_rate: 1,
              fixture_id: "fixture-1",
              results: [],
            },
            baseline: {
              skill_name: "research-assistant",
              mode: "package",
              baseline_pass_rate: 0.5,
              with_skill_pass_rate: 1,
              lift: 0.5,
              adds_value: true,
              per_entry: [],
              measured_at: "2026-04-14T12:00:00.000Z",
            },
          }) as const,
        readSkillContent: () =>
          `---
name: research-assistant
description: >
  Use when the user needs evidence-backed research help.
---

# Research Assistant

Updated draft package.

## Workflow Routing

| Trigger | Workflow |
| --- | --- |
| Research this company | default |
`,
        assessBodyQuality: async () => ({
          score: 0.9,
          reason: "The refreshed body is still valid.",
        }),
        persistPackageCandidateEvaluation: attachCandidateState,
        runCreateReplay: async (options) => {
          replayCalls += 1;
          return {
            skill: "research-assistant",
            skill_path: "/tmp/research-assistant/SKILL.md",
            mode: options.mode,
            agent: "claude",
            proposal_id: options.mode === "routing" ? "fresh-routing" : "fresh-with-skill",
            total: 2,
            passed: 2,
            failed: 0,
            pass_rate: 1,
            fixture_id: options.mode === "routing" ? "fixture-routing" : "fixture-1",
            results: [],
          };
        },
        runCreateBaseline: async () => {
          baselineCalls += 1;
          return {
            skill_name: "research-assistant",
            mode: "package",
            baseline_pass_rate: 0.5,
            with_skill_pass_rate: 1,
            lift: 0.5,
            adds_value: true,
            per_entry: [],
            measured_at: "2026-04-14T12:00:00.000Z",
          };
        },
      },
    );

    expect(replayCalls).toBe(2);
    expect(baselineCalls).toBe(1);
    expect(result.summary.evaluation_source).toBe("fresh");
    expect(result.summary.package_fingerprint).toBe("pkg_sha256_current1234");
    expect(result.summary.candidate_id).toBe("pkgcand_research-assistant_current1234");
  });

  it("returns a baseline_failed status when replay passes but lift does not", async () => {
    const result = await runCreatePackageEvaluation(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
      },
      {
        persistPackageCandidateEvaluation: attachCandidateState,
        runCreateReplay: async () => ({
          skill: "research-assistant",
          skill_path: "/tmp/research-assistant/SKILL.md",
          mode: "package",
          agent: "claude",
          proposal_id: "with-skill",
          total: 2,
          passed: 2,
          failed: 0,
          pass_rate: 1,
          fixture_id: "fixture-1",
          results: [],
          runtime_metrics: {
            eval_runs: 2,
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
        }),
        runCreateBaseline: async () => ({
          skill_name: "research-assistant",
          mode: "package",
          baseline_pass_rate: 0.98,
          with_skill_pass_rate: 1,
          lift: 0.02,
          adds_value: false,
          per_entry: [],
          measured_at: "2026-04-14T12:00:00.000Z",
          runtime_metrics: {
            with_skill: {
              eval_runs: 2,
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
            without_skill: {
              eval_runs: 2,
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
        }),
      },
    );

    expect(result.summary.evaluation_passed).toBe(false);
    expect(result.summary.status).toBe("baseline_failed");
    expect(result.summary.next_command).toBe(
      "selftune create baseline --skill-path /tmp/research-assistant/SKILL.md --mode package",
    );
  });

  it("adds grading context from the deployed baseline and recent grading runs", async () => {
    let receivedBaselineProposalId: string | undefined;

    const result = await runCreatePackageEvaluation(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
      },
      {
        getDb: () => ({}) as never,
        persistPackageCandidateEvaluation: attachCandidateState,
        getLastDeployedProposal: () =>
          ({
            proposal_id: "deploy-42",
            skill_name: "research-assistant",
            action: "deployed",
            timestamp: "2026-04-14T12:00:00.000Z",
            details: "deployed",
          }) as never,
        queryGradingBaseline: (_db, _skillName, proposalId) => {
          receivedBaselineProposalId = proposalId;
          return {
            id: 1,
            skill_name: "research-assistant",
            proposal_id: "deploy-42",
            measured_at: "2026-04-14T12:00:00.000Z",
            pass_rate: 0.82,
            mean_score: 0.74,
            sample_size: 6,
            grading_results_json: null,
          };
        },
        queryRecentGradingResults: () => [
          {
            grading_id: "grade-2",
            session_id: "session-2",
            skill_name: "research-assistant",
            graded_at: "2026-04-14T12:10:00.000Z",
            pass_rate: 0.7,
            mean_score: 0.61,
            total_count: 5,
            passed_count: 3,
            failed_count: 2,
          },
          {
            grading_id: "grade-1",
            session_id: "session-1",
            skill_name: "research-assistant",
            graded_at: "2026-04-14T12:05:00.000Z",
            pass_rate: 0.8,
            mean_score: 0.67,
            total_count: 5,
            passed_count: 4,
            failed_count: 1,
          },
        ],
        runCreateReplay: async () => ({
          skill: "research-assistant",
          skill_path: "/tmp/research-assistant/SKILL.md",
          mode: "package",
          agent: "claude",
          proposal_id: "with-skill",
          total: 2,
          passed: 2,
          failed: 0,
          pass_rate: 1,
          fixture_id: "fixture-1",
          results: [],
        }),
        runCreateBaseline: async () => ({
          skill_name: "research-assistant",
          mode: "package",
          baseline_pass_rate: 0.5,
          with_skill_pass_rate: 1,
          lift: 0.5,
          adds_value: true,
          per_entry: [],
          measured_at: "2026-04-14T12:00:00.000Z",
        }),
      },
    );

    expect(receivedBaselineProposalId).toBe("deploy-42");
    expect(result.summary.grading?.baseline).toEqual({
      proposal_id: "deploy-42",
      measured_at: "2026-04-14T12:00:00.000Z",
      pass_rate: 0.82,
      mean_score: 0.74,
      sample_size: 6,
    });
    expect(result.summary.grading?.recent).toEqual({
      sample_size: 2,
      average_pass_rate: 0.75,
      average_mean_score: 0.64,
      newest_graded_at: "2026-04-14T12:10:00.000Z",
      oldest_graded_at: "2026-04-14T12:05:00.000Z",
    });
    expect(result.summary.grading?.pass_rate_delta).toBeCloseTo(-0.07, 6);
    expect(result.summary.grading?.mean_score_delta).toBeCloseTo(-0.1, 6);
    expect(result.summary.grading?.regressed).toBe(true);
  });

  it("adds the latest deterministic unit-test run to the package summary", async () => {
    const result = await runCreatePackageEvaluation(
      {
        skillPath: "/tmp/research-assistant/SKILL.md",
      },
      {
        persistPackageCandidateEvaluation: attachCandidateState,
        readCanonicalUnitTestRunResult: () => ({
          skill_name: "research-assistant",
          total: 3,
          passed: 2,
          failed: 1,
          pass_rate: 2 / 3,
          run_at: "2026-04-14T12:15:00.000Z",
          results: [
            {
              test_id: "happy-path",
              passed: true,
              assertion_results: [],
              duration_ms: 80,
            },
            {
              test_id: "guardrail-regression",
              passed: false,
              assertion_results: [
                {
                  assertion: {
                    type: "contains",
                    value: "Do not send the raw API key",
                  },
                  passed: false,
                  actual: "Assistant printed the key",
                },
              ],
              duration_ms: 120,
              error: "Assistant leaked the secret",
            },
          ],
        }),
        runCreateReplay: async () => ({
          skill: "research-assistant",
          skill_path: "/tmp/research-assistant/SKILL.md",
          mode: "package",
          agent: "claude",
          proposal_id: "with-skill",
          total: 2,
          passed: 2,
          failed: 0,
          pass_rate: 1,
          fixture_id: "fixture-1",
          results: [],
        }),
        runCreateBaseline: async () => ({
          skill_name: "research-assistant",
          mode: "package",
          baseline_pass_rate: 0.5,
          with_skill_pass_rate: 1,
          lift: 0.5,
          adds_value: true,
          per_entry: [],
          measured_at: "2026-04-14T12:00:00.000Z",
        }),
      },
    );

    expect(result.summary.unit_tests).toEqual({
      total: 3,
      passed: 2,
      failed: 1,
      pass_rate: 2 / 3,
      run_at: "2026-04-14T12:15:00.000Z",
      failing_tests: [
        {
          test_id: "guardrail-regression",
          error: "Assistant leaked the secret",
          failed_assertions: ["contains: Do not send the raw API key"],
        },
      ],
    });
  });

  it("formats a benchmark-style report with skills impact and failure analysis", () => {
    const report = formatCreatePackageBenchmarkReport({
      summary: {
        skill_name: "research-assistant",
        skill_path: "/tmp/research-assistant/SKILL.md",
        mode: "package",
        package_fingerprint: "pkg_sha256_eval123456",
        candidate_id: "pkgcand_research-assistant_eval123456",
        parent_candidate_id: null,
        candidate_generation: 0,
        evaluation_source: "fresh",
        candidate_acceptance: {
          decision: "root",
          compared_to_candidate_id: null,
          decided_at: "2026-04-15T09:00:00.000Z",
          rationale: "Initial measured package candidate for this skill.",
          replay_pass_rate_delta: null,
          routing_pass_rate_delta: null,
          baseline_lift_delta: null,
          body_quality_delta: null,
          unit_test_pass_rate_delta: null,
        },
        status: "baseline_failed",
        evaluation_passed: false,
        next_command:
          "selftune create baseline --skill-path /tmp/research-assistant/SKILL.md --mode package",
        replay: {
          mode: "package",
          validation_mode: "host_replay",
          agent: "claude",
          proposal_id: "create-replay-1",
          fixture_id: "fixture-1",
          total: 2,
          passed: 1,
          failed: 1,
          pass_rate: 0.5,
        },
        routing: {
          mode: "routing",
          validation_mode: "host_replay",
          agent: "claude",
          proposal_id: "create-routing-1",
          fixture_id: "fixture-routing",
          total: 2,
          passed: 1,
          failed: 1,
          pass_rate: 0.5,
        },
        baseline: {
          mode: "package",
          baseline_pass_rate: 0.5,
          with_skill_pass_rate: 0.5,
          lift: 0,
          adds_value: false,
          measured_at: "2026-04-14T12:00:00.000Z",
        },
        body: {
          structural_valid: true,
          structural_reason: "Structural validation passed",
          quality_score: 0.82,
          quality_reason: "The body is clear and preserves the routing section.",
          quality_threshold: 0.6,
          quality_passed: true,
          valid: true,
        },
        grading: {
          baseline: {
            proposal_id: "deploy-42",
            measured_at: "2026-04-14T12:00:00.000Z",
            pass_rate: 0.82,
            mean_score: 0.74,
            sample_size: 6,
          },
          recent: {
            sample_size: 2,
            average_pass_rate: 0.75,
            average_mean_score: 0.64,
            newest_graded_at: "2026-04-14T12:10:00.000Z",
            oldest_graded_at: "2026-04-14T12:05:00.000Z",
          },
          pass_rate_delta: -0.07,
          mean_score_delta: -0.1,
          regressed: true,
        },
        unit_tests: {
          total: 3,
          passed: 2,
          failed: 1,
          pass_rate: 2 / 3,
          run_at: "2026-04-14T12:15:00.000Z",
          failing_tests: [
            {
              test_id: "guardrail-regression",
              error: "Assistant leaked the secret",
              failed_assertions: ["contains: Do not send the raw API key"],
            },
          ],
        },
      },
      replay: {
        skill: "research-assistant",
        skill_path: "/tmp/research-assistant/SKILL.md",
        mode: "package",
        agent: "claude",
        proposal_id: "create-replay-1",
        total: 2,
        passed: 1,
        failed: 1,
        pass_rate: 0.5,
        fixture_id: "fixture-1",
        results: [
          {
            query: "plan a literature review and read the bundled research checklist",
            should_trigger: true,
            triggered: false,
            passed: false,
            evidence: "assistant skipped the skill and answered directly",
          },
        ],
      },
      baseline: {
        skill_name: "research-assistant",
        mode: "package",
        baseline_pass_rate: 0.5,
        with_skill_pass_rate: 0.5,
        lift: 0,
        adds_value: false,
        measured_at: "2026-04-14T12:00:00.000Z",
        per_entry: [
          {
            skill_name: "research-assistant",
            query: "plan a literature review and read the bundled research checklist",
            with_skill: false,
            triggered: false,
            pass: false,
            measured_at: "2026-04-14T12:00:00.000Z",
          },
          {
            skill_name: "research-assistant",
            query: "plan a literature review and read the bundled research checklist",
            with_skill: true,
            triggered: false,
            pass: true,
            measured_at: "2026-04-14T12:00:00.000Z",
          },
        ],
      },
    });

    expect(report).toContain("CREATE PACKAGE BENCHMARK REPORT: research-assistant");
    expect(report).toContain("SOURCE: fresh");
    expect(report).toContain(
      "CANDIDATE: id=pkgcand_research-assistant_eval123456 | generation=0 | parent=root",
    );
    expect(report).toContain(
      "ACCEPTANCE: root vs root | Initial measured package candidate for this skill.",
    );
    expect(report).toContain(
      "ROUTING VALIDATION: pass_rate=50.0% | passed=1/2 | fixture=fixture-routing",
    );
    expect(report).toContain(
      "BODY VALIDATION: structural=pass | quality=0.82 | threshold=0.60 | valid=yes",
    );
    expect(report).toContain("SKILLS IMPACT: without_skill=50.0% | with_skill=50.0% | lift=0.000");
    expect(report).toContain(
      "UNIT TESTS: passed=2/3 | pass_rate=66.7% | latest_run=2026-04-14T12:15:00.000Z",
    );
    expect(report).toContain(
      "GRADING CONTEXT: baseline=82.0% | recent_avg=75.0% | delta=-7.0% | regressed=yes",
    );
    expect(report).toContain(
      "query: plan a literature review and read the bundled research checklist",
    );
    expect(report).toContain("expected: trigger | actual: skipped");
    expect(report).toContain("without skill: fail | with skill: pass");
    expect(report).toContain("unit test: guardrail-regression");
    expect(report).toContain("Assistant leaked the secret");
    expect(report).toContain("RECOMMENDATION: DO NOT PUBLISH");
    expect(report).toContain(
      "NEXT: selftune create baseline --skill-path /tmp/research-assistant/SKILL.md --mode package",
    );
  });
});
