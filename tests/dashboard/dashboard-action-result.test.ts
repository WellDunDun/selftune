import { describe, expect, it } from "bun:test";

import {
  extractDashboardActionSummary,
  resolveDashboardActionOutcome,
} from "../../packages/runtime/dashboard-action-result.js";

describe("dashboard-action-result", () => {
  it("extracts create check status for draft-package actions", () => {
    const summary = extractDashboardActionSummary(
      "create-check",
      JSON.stringify({
        skill: "Taxes",
        ok: false,
        state: "needs_spec_validation",
        spec_validation: {
          ok: false,
          validator: "skills-ref",
        },
        readiness: {
          summary:
            "Local package checks pass, but Agent Skills spec validation has not run yet. Run create check before publishing.",
          recommended_command: "selftune create check --skill-path /tmp/Taxes/SKILL.md",
        },
      }),
    );

    expect(summary).toEqual({
      reason:
        "Local package checks pass, but Agent Skills spec validation has not run yet. Run create check before publishing.",
      improved: false,
      deployed: null,
      before_pass_rate: null,
      after_pass_rate: null,
      net_change: null,
      validation_mode: "skills-ref",
      recommended_command: "selftune create check --skill-path /tmp/Taxes/SKILL.md",
    });
  });

  it("treats validated replay dry-runs as success even when the CLI exits 1", () => {
    const outcome = resolveDashboardActionOutcome({
      action: "replay-dry-run",
      exitCode: 1,
      stderr: "[NOT DEPLOYED] Dry run - proposal validated but not deployed",
      stdout: JSON.stringify({
        skill: "Taxes",
        deployed: false,
        reason: "Dry run - proposal validated but not deployed",
        improved: true,
      }),
    });

    expect(outcome.success).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.summary).toEqual({
      reason: "Dry run - proposal validated but not deployed",
      improved: true,
      deployed: false,
      before_pass_rate: null,
      after_pass_rate: null,
      net_change: null,
      validation_mode: null,
    });
  });

  it("keeps real replay failures as failures", () => {
    const outcome = resolveDashboardActionOutcome({
      action: "replay-dry-run",
      exitCode: 1,
      stderr: "validation failed",
      stdout: JSON.stringify({
        skill: "Taxes",
        deployed: false,
        reason: "Validation failed",
        improved: false,
      }),
    });

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("validation failed");
  });

  it("extracts replay dry-run lift details for the live run screen", () => {
    const summary = extractDashboardActionSummary(
      "replay-dry-run",
      JSON.stringify({
        skill: "Taxes",
        deployed: false,
        reason: "Dry run - proposal validated but not deployed",
        improved: true,
        before_pass_rate: 0.75,
        after_pass_rate: 1,
        net_change: 0.25,
        validation_mode: "judge",
      }),
    );

    expect(summary).toEqual({
      reason: "Dry run - proposal validated but not deployed",
      improved: true,
      deployed: false,
      before_pass_rate: 0.75,
      after_pass_rate: 1,
      net_change: 0.25,
      validation_mode: "judge",
    });
  });

  it("extracts search-run summary from structured output", () => {
    const summary = extractDashboardActionSummary(
      "search-run",
      JSON.stringify({
        search_id: "sr_abc123",
        skill_name: "TestSkill",
        parent_candidate_id: "cand_parent1",
        candidates_evaluated: 3,
        winner_candidate_id: "cand_winner1",
        winner_rationale: "Best measured delta",
        started_at: "2026-04-15T00:00:00Z",
        completed_at: "2026-04-15T00:01:00Z",
        next_command: "selftune publish --skill-path /tmp/TestSkill/SKILL.md",
        provenance: {
          frontier_size: 5,
          parent_selection_method: "best_evidence",
          surface_plan: {
            routing_count: 4,
            body_count: 1,
            weakness_source: "accepted_frontier",
            routing_weakness: 0.9,
            body_weakness: 0.1,
          },
          candidate_fingerprints: ["fp1", "fp2", "fp3"],
          evaluation_summaries: [],
        },
      }),
    );

    expect(summary).not.toBeNull();
    expect(summary?.search_run).not.toBeNull();
    expect(summary?.search_run?.search_id).toBe("sr_abc123");
    expect(summary?.search_run?.parent_candidate_id).toBe("cand_parent1");
    expect(summary?.search_run?.winner_candidate_id).toBe("cand_winner1");
    expect(summary?.search_run?.candidates_evaluated).toBe(3);
    expect(summary?.search_run?.frontier_size).toBe(5);
    expect(summary?.search_run?.parent_selection_method).toBe("best_evidence");
    expect(summary?.search_run?.surface_plan?.routing_count).toBe(4);
    expect(summary?.search_run?.surface_plan?.body_count).toBe(1);
    expect(summary?.search_run?.surface_plan?.weakness_source).toBe("accepted_frontier");
    expect(summary?.reason).toBe("Best measured delta");
    expect(summary?.improved).toBe(true);
    expect(summary?.recommended_command).toBe(
      "selftune publish --skill-path /tmp/TestSkill/SKILL.md",
    );
  });

  it("handles search-run with no winner", () => {
    const summary = extractDashboardActionSummary(
      "search-run",
      JSON.stringify({
        search_id: "sr_no_win",
        skill_name: "TestSkill",
        parent_candidate_id: null,
        candidates_evaluated: 2,
        winner_candidate_id: null,
        winner_rationale: null,
        started_at: "2026-04-15T00:00:00Z",
        completed_at: "2026-04-15T00:01:00Z",
        provenance: {
          frontier_size: 1,
          parent_selection_method: "random",
          candidate_fingerprints: ["fp1", "fp2"],
          evaluation_summaries: [],
        },
      }),
    );

    expect(summary).not.toBeNull();
    expect(summary?.search_run?.winner_candidate_id).toBeNull();
    expect(summary?.improved).toBe(false);
  });

  it("resolves search-run action outcome as success on exit 0", () => {
    const outcome = resolveDashboardActionOutcome({
      action: "search-run",
      exitCode: 0,
      stderr: null,
      stdout: JSON.stringify({
        search_id: "sr_ok",
        skill_name: "TestSkill",
        parent_candidate_id: null,
        candidates_evaluated: 1,
        winner_candidate_id: "cand_w",
        winner_rationale: "Only candidate",
        started_at: "2026-04-15T00:00:00Z",
        completed_at: "2026-04-15T00:01:00Z",
        provenance: {
          frontier_size: 0,
          parent_selection_method: "none",
          candidate_fingerprints: ["fp1"],
          evaluation_summaries: [],
        },
      }),
    });

    expect(outcome.success).toBe(true);
    expect(outcome.summary?.search_run?.search_id).toBe("sr_ok");
  });

  it("returns null summary for non-replay non-search actions", () => {
    const summary = extractDashboardActionSummary(
      "generate-evals",
      JSON.stringify({ skill: "Foo", improved: true }),
    );

    expect(summary).toBeNull();
  });

  it("supports the current evolve dry-run before/after keys", () => {
    const summary = extractDashboardActionSummary(
      "replay-dry-run",
      JSON.stringify({
        skill: "Taxes",
        deployed: false,
        reason: "Dry run - proposal validated but not deployed",
        improved: true,
        before: 0.75,
        after: 1,
        net_change: 0.25,
      }),
    );

    expect(summary?.before_pass_rate).toBe(0.75);
    expect(summary?.after_pass_rate).toBe(1);
    expect(summary?.net_change).toBe(0.25);
  });

  it("extracts package baseline lift details for dashboard baseline actions", () => {
    const summary = extractDashboardActionSummary(
      "measure-baseline",
      JSON.stringify({
        skill_name: "Taxes",
        mode: "package",
        baseline_pass_rate: 0.4,
        with_skill_pass_rate: 0.9,
        lift: 0.5,
        adds_value: true,
      }),
    );

    expect(summary).toEqual({
      reason: "Baseline measured",
      improved: true,
      deployed: null,
      before_pass_rate: 0.4,
      after_pass_rate: 0.9,
      net_change: 0.5,
      validation_mode: "host_replay",
    });
  });

  it("keeps package runtime efficiency on direct baseline summaries", () => {
    const summary = extractDashboardActionSummary(
      "measure-baseline",
      JSON.stringify({
        skill_name: "Taxes",
        mode: "package",
        baseline_pass_rate: 0.4,
        with_skill_pass_rate: 0.9,
        lift: 0.5,
        adds_value: true,
        runtime_metrics: {
          with_skill: {
            eval_runs: 5,
            usage_observations: 5,
            total_duration_ms: 18000,
            avg_duration_ms: 3600,
            total_input_tokens: 700,
            total_output_tokens: 180,
            total_cache_creation_input_tokens: 80,
            total_cache_read_input_tokens: 260,
            total_cost_usd: 0.21,
            total_turns: 9,
          },
          without_skill: {
            eval_runs: 5,
            usage_observations: 5,
            total_duration_ms: 24000,
            avg_duration_ms: 4800,
            total_input_tokens: 980,
            total_output_tokens: 160,
            total_cache_creation_input_tokens: 75,
            total_cache_read_input_tokens: 220,
            total_cost_usd: 0.29,
            total_turns: 11,
          },
        },
      }),
    );

    expect(summary?.package_efficiency).toEqual({
      with_skill: {
        eval_runs: 5,
        usage_observations: 5,
        total_duration_ms: 18000,
        avg_duration_ms: 3600,
        total_input_tokens: 700,
        total_output_tokens: 180,
        total_cache_creation_input_tokens: 80,
        total_cache_read_input_tokens: 260,
        total_cost_usd: 0.21,
        total_turns: 9,
      },
      without_skill: {
        eval_runs: 5,
        usage_observations: 5,
        total_duration_ms: 24000,
        avg_duration_ms: 4800,
        total_input_tokens: 980,
        total_output_tokens: 160,
        total_cache_creation_input_tokens: 75,
        total_cache_read_input_tokens: 220,
        total_cost_usd: 0.29,
        total_turns: 11,
      },
    });
  });

  it("extracts package evaluation details for draft publish actions", () => {
    const summary = extractDashboardActionSummary(
      "deploy-candidate",
      JSON.stringify({
        skill: "Taxes",
        published: true,
        watch_started: false,
        package_evaluation: {
          status: "passed",
          evaluation_passed: true,
          evaluation_source: "artifact_cache",
          candidate_id: "pkgcand_Taxes_eval123456",
          parent_candidate_id: "pkgcand_Taxes_root123456",
          candidate_generation: 2,
          candidate_acceptance: {
            decision: "accepted",
            compared_to_candidate_id: "pkgcand_Taxes_root123456",
            decided_at: "2026-04-15T09:00:00.000Z",
            rationale: "Measured improvement vs parent: replay +10.0%, baseline lift +0.120.",
            replay_pass_rate_delta: 0.1,
            routing_pass_rate_delta: null,
            baseline_lift_delta: 0.12,
            body_quality_delta: null,
            unit_test_pass_rate_delta: null,
          },
          next_command: null,
          replay: {
            validation_mode: "host_replay",
          },
          baseline: {
            baseline_pass_rate: 0.45,
            with_skill_pass_rate: 0.85,
            lift: 0.4,
          },
          evidence: {
            replay_failures: 1,
            baseline_wins: 2,
            baseline_regressions: 0,
            replay_failure_samples: [
              {
                query: "draft my taxes",
                evidence: "selected competing skill",
              },
            ],
            baseline_win_samples: [
              {
                query: "file my taxes",
                evidence: "with-skill replay completed successfully",
              },
            ],
            baseline_regression_samples: [],
          },
          efficiency: {
            with_skill: {
              eval_runs: 6,
              usage_observations: 6,
              total_duration_ms: 24000,
              avg_duration_ms: 4000,
              total_input_tokens: 1200,
              total_output_tokens: 300,
              total_cache_creation_input_tokens: 100,
              total_cache_read_input_tokens: 500,
              total_cost_usd: 0.42,
              total_turns: 12,
            },
            without_skill: {
              eval_runs: 6,
              usage_observations: 6,
              total_duration_ms: 31000,
              avg_duration_ms: 5166.7,
              total_input_tokens: 1500,
              total_output_tokens: 280,
              total_cache_creation_input_tokens: 120,
              total_cache_read_input_tokens: 450,
              total_cost_usd: 0.51,
              total_turns: 15,
            },
          },
          routing: {
            mode: "routing",
            validation_mode: "host_replay",
            agent: "claude",
            proposal_id: "create-routing-1",
            fixture_id: "fixture-routing",
            total: 6,
            passed: 5,
            failed: 1,
            pass_rate: 5 / 6,
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
      }),
    );

    expect(summary).toEqual({
      reason: "Package evaluation passed",
      improved: true,
      deployed: true,
      before_pass_rate: 0.45,
      after_pass_rate: 0.85,
      net_change: 0.4,
      validation_mode: "host_replay",
      package_evaluation_source: "artifact_cache",
      package_candidate_id: "pkgcand_Taxes_eval123456",
      package_parent_candidate_id: "pkgcand_Taxes_root123456",
      package_candidate_generation: 2,
      package_candidate_acceptance_decision: "accepted",
      package_candidate_acceptance_rationale:
        "Measured improvement vs parent: replay +10.0%, baseline lift +0.120.",
      package_evidence: {
        replay_failures: 1,
        baseline_wins: 2,
        baseline_regressions: 0,
        replay_failure_samples: [
          {
            query: "draft my taxes",
            evidence: "selected competing skill",
          },
        ],
        baseline_win_samples: [
          {
            query: "file my taxes",
            evidence: "with-skill replay completed successfully",
          },
        ],
        baseline_regression_samples: [],
      },
      package_efficiency: {
        with_skill: {
          eval_runs: 6,
          usage_observations: 6,
          total_duration_ms: 24000,
          avg_duration_ms: 4000,
          total_input_tokens: 1200,
          total_output_tokens: 300,
          total_cache_creation_input_tokens: 100,
          total_cache_read_input_tokens: 500,
          total_cost_usd: 0.42,
          total_turns: 12,
        },
        without_skill: {
          eval_runs: 6,
          usage_observations: 6,
          total_duration_ms: 31000,
          avg_duration_ms: 5166.7,
          total_input_tokens: 1500,
          total_output_tokens: 280,
          total_cache_creation_input_tokens: 120,
          total_cache_read_input_tokens: 450,
          total_cost_usd: 0.51,
          total_turns: 15,
        },
      },
      package_routing: {
        mode: "routing",
        validation_mode: "host_replay",
        agent: "claude",
        proposal_id: "create-routing-1",
        fixture_id: "fixture-routing",
        total: 6,
        passed: 5,
        failed: 1,
        pass_rate: 5 / 6,
      },
      package_body: {
        structural_valid: true,
        structural_reason: "Structural validation passed",
        quality_score: 0.82,
        quality_reason: "The body is clear and preserves the routing section.",
        quality_threshold: 0.6,
        quality_passed: true,
        valid: true,
      },
      package_grading: {
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
      package_unit_tests: {
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
      watch_gate_passed: null,
    });
  });

  it("accepts candidate cache provenance for package summaries", () => {
    const summary = extractDashboardActionSummary(
      "report-package",
      JSON.stringify({
        summary: {
          skill_name: "Taxes",
          status: "passed",
          evaluation_passed: true,
          evaluation_source: "candidate_cache",
          next_command: null,
          replay: {
            validation_mode: "host_replay",
          },
          baseline: {
            baseline_pass_rate: 0.45,
            with_skill_pass_rate: 0.85,
            lift: 0.4,
          },
        },
      }),
    );

    expect(summary?.package_evaluation_source).toBe("candidate_cache");
  });

  it("extracts package report details for draft benchmark actions", () => {
    const summary = extractDashboardActionSummary(
      "report-package",
      JSON.stringify({
        summary: {
          skill_name: "Taxes",
          status: "passed",
          evaluation_passed: true,
          next_command: "selftune create publish --skill-path /tmp/Taxes/SKILL.md",
          replay: {
            validation_mode: "host_replay",
          },
          baseline: {
            baseline_pass_rate: 0.45,
            with_skill_pass_rate: 0.85,
            lift: 0.4,
          },
          evidence: {
            replay_failures: 1,
            baseline_wins: 1,
            baseline_regressions: 0,
            replay_failure_samples: [
              {
                query: "late tax filing",
                evidence: "did not select target skill",
              },
            ],
            baseline_win_samples: [
              {
                query: "estimate state taxes",
                evidence: "with-skill replay passed",
              },
            ],
            baseline_regression_samples: [],
          },
          efficiency: {
            with_skill: {
              eval_runs: 6,
              usage_observations: 6,
              total_duration_ms: 18000,
              avg_duration_ms: 3000,
              total_input_tokens: 900,
              total_output_tokens: 220,
              total_cache_creation_input_tokens: 90,
              total_cache_read_input_tokens: 410,
              total_cost_usd: 0.28,
              total_turns: 10,
            },
            without_skill: {
              eval_runs: 6,
              usage_observations: 6,
              total_duration_ms: 25000,
              avg_duration_ms: 4166.7,
              total_input_tokens: 1100,
              total_output_tokens: 210,
              total_cache_creation_input_tokens: 95,
              total_cache_read_input_tokens: 360,
              total_cost_usd: 0.33,
              total_turns: 13,
            },
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
        },
      }),
    );

    expect(summary).toEqual({
      reason: "Package report ready",
      improved: true,
      deployed: null,
      before_pass_rate: 0.45,
      after_pass_rate: 0.85,
      net_change: 0.4,
      validation_mode: "host_replay",
      recommended_command: "selftune create publish --skill-path /tmp/Taxes/SKILL.md",
      package_evidence: {
        replay_failures: 1,
        baseline_wins: 1,
        baseline_regressions: 0,
        replay_failure_samples: [
          {
            query: "late tax filing",
            evidence: "did not select target skill",
          },
        ],
        baseline_win_samples: [
          {
            query: "estimate state taxes",
            evidence: "with-skill replay passed",
          },
        ],
        baseline_regression_samples: [],
      },
      package_efficiency: {
        with_skill: {
          eval_runs: 6,
          usage_observations: 6,
          total_duration_ms: 18000,
          avg_duration_ms: 3000,
          total_input_tokens: 900,
          total_output_tokens: 220,
          total_cache_creation_input_tokens: 90,
          total_cache_read_input_tokens: 410,
          total_cost_usd: 0.28,
          total_turns: 10,
        },
        without_skill: {
          eval_runs: 6,
          usage_observations: 6,
          total_duration_ms: 25000,
          avg_duration_ms: 4166.7,
          total_input_tokens: 1100,
          total_output_tokens: 210,
          total_cache_creation_input_tokens: 95,
          total_cache_read_input_tokens: 360,
          total_cost_usd: 0.33,
          total_turns: 13,
        },
      },
      package_grading: {
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
    });
  });

  it("extracts verify alias summaries from nested package reports", () => {
    const summary = extractDashboardActionSummary(
      "report-package",
      JSON.stringify({
        skill: "Taxes",
        skill_path: "/tmp/Taxes/SKILL.md",
        readiness_state: "ready_to_publish",
        verified: true,
        next_command: "selftune publish --skill-path /tmp/Taxes/SKILL.md",
        readiness: {
          ok: true,
          state: "ready_to_publish",
          summary: "Draft package is ready to publish.",
          next_command: null,
        },
        report: {
          summary: {
            skill_name: "Taxes",
            status: "passed",
            evaluation_passed: true,
            next_command: "selftune publish --skill-path /tmp/Taxes/SKILL.md",
            replay: {
              validation_mode: "host_replay",
            },
            baseline: {
              baseline_pass_rate: 0.45,
              with_skill_pass_rate: 0.85,
              lift: 0.4,
            },
          },
        },
      }),
    );

    expect(summary).toEqual({
      reason: "Package report ready",
      improved: true,
      deployed: null,
      before_pass_rate: 0.45,
      after_pass_rate: 0.85,
      net_change: 0.4,
      validation_mode: "host_replay",
      recommended_command: "selftune publish --skill-path /tmp/Taxes/SKILL.md",
    });
  });

  it("falls back to readiness details when verify exits before package evaluation", () => {
    const summary = extractDashboardActionSummary(
      "report-package",
      JSON.stringify({
        skill: "Taxes",
        skill_path: "/tmp/Taxes/SKILL.md",
        readiness_state: "needs_evals",
        verified: false,
        next_command: "selftune eval generate --skill Taxes --skill-path /tmp/Taxes/SKILL.md",
        readiness: {
          ok: false,
          state: "needs_evals",
          summary: "Draft package still needs eval coverage before verify can continue.",
          next_command: "selftune eval generate --skill Taxes --skill-path /tmp/Taxes/SKILL.md",
        },
      }),
    );

    expect(summary).toEqual({
      reason: "Draft package still needs eval coverage before verify can continue.",
      improved: false,
      deployed: null,
      before_pass_rate: null,
      after_pass_rate: null,
      net_change: null,
      validation_mode: null,
      recommended_command: "selftune eval generate --skill Taxes --skill-path /tmp/Taxes/SKILL.md",
    });
  });

  it("extracts measured watch details for direct watch actions", () => {
    const summary = extractDashboardActionSummary(
      "watch",
      JSON.stringify({
        snapshot: {
          timestamp: "2026-04-14T12:30:00.000Z",
          skill_name: "Taxes",
          window_sessions: 20,
          skill_checks: 8,
          pass_rate: 0.7,
          false_negative_rate: 0.3,
          by_invocation_type: {
            explicit: { passed: 2, total: 3 },
            implicit: { passed: 2, total: 3 },
            contextual: { passed: 1, total: 1 },
            negative: { passed: 0, total: 1 },
          },
          regression_detected: true,
          baseline_pass_rate: 0.9,
        },
        alert:
          'regression detected for "Taxes": pass_rate=0.70 below baseline=0.90 minus threshold=0.10',
        rolledBack: false,
        recommendation:
          "Consider running: selftune rollback --skill Taxes --skill-path /tmp/Taxes/SKILL.md",
        recommended_command: "selftune rollback --skill Taxes --skill-path /tmp/Taxes/SKILL.md",
        gradeAlert: null,
        gradeRegression: null,
        efficiencyAlert:
          'efficiency regression detected for "Taxes": input_tokens +42.0% exceeds threshold=25.0%',
        efficiencyRegression: {
          sample_size: 4,
          baseline_avg_duration_ms: 1000,
          observed_avg_duration_ms: null,
          duration_delta_ratio: null,
          baseline_avg_input_tokens: 100,
          observed_avg_input_tokens: 142,
          input_tokens_delta_ratio: 0.42,
          baseline_avg_output_tokens: 40,
          observed_avg_output_tokens: 48,
          output_tokens_delta_ratio: 0.2,
          baseline_avg_turns: 1,
          observed_avg_turns: 2,
          turns_delta_ratio: 1,
        },
      }),
    );

    expect(summary).toEqual({
      reason:
        'regression detected for "Taxes": pass_rate=0.70 below baseline=0.90 minus threshold=0.10',
      improved: false,
      deployed: true,
      before_pass_rate: 0.9,
      before_label: "Baseline",
      after_pass_rate: 0.7,
      after_label: "Observed",
      net_change: -0.2,
      net_change_label: "Delta",
      validation_mode: "trigger_watch",
      validation_label: "Signal",
      recommended_command: "selftune rollback --skill Taxes --skill-path /tmp/Taxes/SKILL.md",
      package_watch: {
        snapshot: {
          timestamp: "2026-04-14T12:30:00.000Z",
          skill_name: "Taxes",
          window_sessions: 20,
          skill_checks: 8,
          pass_rate: 0.7,
          false_negative_rate: 0.3,
          by_invocation_type: {
            explicit: { passed: 2, total: 3 },
            implicit: { passed: 2, total: 3 },
            contextual: { passed: 1, total: 1 },
            negative: { passed: 0, total: 1 },
          },
          regression_detected: true,
          baseline_pass_rate: 0.9,
        },
        alert:
          'regression detected for "Taxes": pass_rate=0.70 below baseline=0.90 minus threshold=0.10',
        rolled_back: false,
        recommendation:
          "Consider running: selftune rollback --skill Taxes --skill-path /tmp/Taxes/SKILL.md",
        recommended_command: "selftune rollback --skill Taxes --skill-path /tmp/Taxes/SKILL.md",
        grade_alert: null,
        grade_regression: null,
        efficiency_alert:
          'efficiency regression detected for "Taxes": input_tokens +42.0% exceeds threshold=25.0%',
        efficiency_regression: {
          sample_size: 4,
          baseline_avg_duration_ms: 1000,
          observed_avg_duration_ms: null,
          duration_delta_ratio: null,
          baseline_avg_input_tokens: 100,
          observed_avg_input_tokens: 142,
          input_tokens_delta_ratio: 0.42,
          baseline_avg_output_tokens: 40,
          observed_avg_output_tokens: 48,
          output_tokens_delta_ratio: 0.2,
          baseline_avg_turns: 1,
          observed_avg_turns: 2,
          turns_delta_ratio: 1,
        },
      },
    });
  });

  it("prefers nested watch results for draft publish watch actions", () => {
    const summary = extractDashboardActionSummary(
      "watch",
      JSON.stringify({
        skill: "Taxes",
        published: true,
        watch_started: true,
        package_evaluation: {
          status: "passed",
          evaluation_passed: true,
          next_command: null,
          replay: {
            validation_mode: "host_replay",
          },
          baseline: {
            baseline_pass_rate: 0.45,
            with_skill_pass_rate: 0.85,
            lift: 0.4,
          },
          evidence: {
            replay_failures: 1,
            baseline_wins: 1,
            baseline_regressions: 0,
            replay_failure_samples: [
              {
                query: "late tax filing",
                evidence: "did not select target skill",
              },
            ],
            baseline_win_samples: [
              {
                query: "estimate state taxes",
                evidence: "with-skill replay passed",
              },
            ],
            baseline_regression_samples: [],
          },
          efficiency: {
            with_skill: {
              eval_runs: 6,
              usage_observations: 6,
              total_duration_ms: 18000,
              avg_duration_ms: 3000,
              total_input_tokens: 900,
              total_output_tokens: 220,
              total_cache_creation_input_tokens: 90,
              total_cache_read_input_tokens: 410,
              total_cost_usd: 0.28,
              total_turns: 10,
            },
            without_skill: {
              eval_runs: 6,
              usage_observations: 6,
              total_duration_ms: 25000,
              avg_duration_ms: 4166.7,
              total_input_tokens: 1100,
              total_output_tokens: 210,
              total_cache_creation_input_tokens: 95,
              total_cache_read_input_tokens: 360,
              total_cost_usd: 0.33,
              total_turns: 13,
            },
          },
        },
        watch_result: {
          snapshot: {
            timestamp: "2026-04-14T12:30:00.000Z",
            skill_name: "Taxes",
            window_sessions: 20,
            skill_checks: 6,
            pass_rate: 0.88,
            false_negative_rate: 0.12,
            by_invocation_type: {
              explicit: { passed: 2, total: 2 },
              implicit: { passed: 2, total: 3 },
              contextual: { passed: 1, total: 1 },
              negative: { passed: 0, total: 0 },
            },
            regression_detected: false,
            baseline_pass_rate: 0.8,
          },
          alert: null,
          rolledBack: false,
          recommendation:
            'Skill "Taxes" is stable. Pass rate 0.88 is within acceptable range of baseline 0.80.',
          recommended_command: null,
          gradeAlert: null,
          gradeRegression: null,
        },
      }),
    );

    expect(summary).toEqual({
      reason:
        'Skill "Taxes" is stable. Pass rate 0.88 is within acceptable range of baseline 0.80.',
      improved: true,
      deployed: true,
      before_pass_rate: 0.8,
      before_label: "Baseline",
      after_pass_rate: 0.88,
      after_label: "Observed",
      net_change: 0.08,
      net_change_label: "Delta",
      validation_mode: "live_watch",
      validation_label: "Signal",
      package_evidence: {
        replay_failures: 1,
        baseline_wins: 1,
        baseline_regressions: 0,
        replay_failure_samples: [
          {
            query: "late tax filing",
            evidence: "did not select target skill",
          },
        ],
        baseline_win_samples: [
          {
            query: "estimate state taxes",
            evidence: "with-skill replay passed",
          },
        ],
        baseline_regression_samples: [],
      },
      package_efficiency: {
        with_skill: {
          eval_runs: 6,
          usage_observations: 6,
          total_duration_ms: 18000,
          avg_duration_ms: 3000,
          total_input_tokens: 900,
          total_output_tokens: 220,
          total_cache_creation_input_tokens: 90,
          total_cache_read_input_tokens: 410,
          total_cost_usd: 0.28,
          total_turns: 10,
        },
        without_skill: {
          eval_runs: 6,
          usage_observations: 6,
          total_duration_ms: 25000,
          avg_duration_ms: 4166.7,
          total_input_tokens: 1100,
          total_output_tokens: 210,
          total_cache_creation_input_tokens: 95,
          total_cache_read_input_tokens: 360,
          total_cost_usd: 0.33,
          total_turns: 13,
        },
      },
      package_watch: {
        snapshot: {
          timestamp: "2026-04-14T12:30:00.000Z",
          skill_name: "Taxes",
          window_sessions: 20,
          skill_checks: 6,
          pass_rate: 0.88,
          false_negative_rate: 0.12,
          by_invocation_type: {
            explicit: { passed: 2, total: 2 },
            implicit: { passed: 2, total: 3 },
            contextual: { passed: 1, total: 1 },
            negative: { passed: 0, total: 0 },
          },
          regression_detected: false,
          baseline_pass_rate: 0.8,
        },
        alert: null,
        rolled_back: false,
        recommendation:
          'Skill "Taxes" is stable. Pass rate 0.88 is within acceptable range of baseline 0.80.',
        recommended_command: null,
        grade_alert: null,
        grade_regression: null,
      },
    });
  });

  it("treats watch regressions as failures even when a wrapper command exits 0", () => {
    const outcome = resolveDashboardActionOutcome({
      action: "watch",
      exitCode: 0,
      stderr: null,
      stdout: JSON.stringify({
        skill: "Taxes",
        published: true,
        watch_started: false,
        package_evaluation: {
          status: "passed",
          evaluation_passed: true,
          replay: {
            validation_mode: "host_replay",
          },
          baseline: {
            baseline_pass_rate: 0.45,
            with_skill_pass_rate: 0.85,
            lift: 0.4,
          },
        },
        watch_result: {
          snapshot: {
            timestamp: "2026-04-14T12:30:00.000Z",
            skill_name: "Taxes",
            window_sessions: 20,
            skill_checks: 6,
            pass_rate: 0.62,
            false_negative_rate: 0.38,
            by_invocation_type: {
              explicit: { passed: 2, total: 2 },
              implicit: { passed: 1, total: 3 },
              contextual: { passed: 0, total: 1 },
              negative: { passed: 0, total: 0 },
            },
            regression_detected: true,
            baseline_pass_rate: 0.8,
          },
          alert:
            'regression detected for "Taxes": pass_rate=0.62 below baseline=0.80 minus threshold=0.10',
          rolledBack: false,
          recommendation:
            "Consider running: selftune rollback --skill Taxes --skill-path /tmp/Taxes/SKILL.md",
          recommended_command: "selftune rollback --skill Taxes --skill-path /tmp/Taxes/SKILL.md",
          gradeAlert: null,
          gradeRegression: null,
        },
      }),
    });

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("regression detected");
    expect(outcome.summary?.validation_mode).toBe("trigger_watch");
  });
});
